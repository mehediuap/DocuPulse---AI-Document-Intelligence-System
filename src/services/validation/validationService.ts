/**
 * Data Validation Service
 * Performs mathematical, logical, and business validation on extracted invoice records.
 * Never silently modifies source data.
 */

import { InvoiceExtractionResult } from '../extraction/schemas.ts';
import {
  ValidationSummary,
  ValidationIssue,
  ValidationConfig,
  FinancialReconciliation,
  ValidationStatus,
} from './types.ts';
import {
  addDecimals,
  multiplyDecimals,
  getAbsoluteDelta,
  roundToTwoDecimals,
  isWithinTolerance,
} from './decimalUtils.ts';
import { DuplicateDetector } from './duplicateDetector.ts';

const DEFAULT_CONFIG: ValidationConfig = {
  roundingTolerance: 0.05, // 5 cents tolerance
  requireLineItems: false,
  allowNegativeAmounts: false,
  futureDateGraceDays: 7,
  uncertaintyThreshold: 0.70,
};

export class ValidationService {
  /**
   * Validates an extracted invoice record against financial and business integrity rules.
   */
  public static validateInvoice(
    invoice: InvoiceExtractionResult,
    historicalInvoices: InvoiceExtractionResult[] = [],
    customConfig?: Partial<ValidationConfig>
  ): ValidationSummary {
    const config: ValidationConfig = { ...DEFAULT_CONFIG, ...customConfig };
    const issues: ValidationIssue[] = [];
    const manualReviewReasons: string[] = [];

    for (const schemaIssue of invoice.extraction_metadata.schemaIssues || []) {
      if (schemaIssue.severity !== 'error') continue;
      issues.push({
        code: 'INVALID_NUMERIC_VALUE',
        severity: 'error',
        field: schemaIssue.field,
        message: schemaIssue.message,
        manualReviewReason: `Invalid extracted value for "${schemaIssue.field}".`,
      });
      manualReviewReasons.push(`Invalid extracted value for ${schemaIssue.field}`);
    }

    // 1. Missing Required Fields Check
    if (!invoice.invoice_number) {
      issues.push({
        code: 'MISSING_REQUIRED_FIELD',
        severity: 'warning',
        field: 'invoice_number',
        message: 'Required field "invoice_number" is missing or unparseable.',
        manualReviewReason: 'Cannot process invoice without unique identifier.',
      });
      manualReviewReasons.push('Invoice number missing');
    }

    if (!invoice.invoice_date) {
      issues.push({
        code: 'MISSING_REQUIRED_FIELD',
        severity: 'warning',
        field: 'invoice_date',
        message: 'Required field "invoice_date" is missing or unparseable.',
        manualReviewReason: 'Issue date is mandatory for tax and accounting periods.',
      });
      manualReviewReasons.push('Invoice date missing');
    }

    if (!invoice.supplier_name) {
      issues.push({
        code: 'MISSING_REQUIRED_FIELD',
        severity: 'warning',
        field: 'supplier_name',
        message: 'Required field "supplier_name" is missing or unparseable.',
        manualReviewReason: 'Vendor identity must be verified for payment authorization.',
      });
      manualReviewReasons.push('Supplier name missing');
    }

    if (!invoice.customer_name) {
      issues.push({
        code: 'MISSING_REQUIRED_FIELD',
        severity: 'warning',
        field: 'customer_name',
        message: 'Required field "customer_name" is missing or unparseable.',
        manualReviewReason: 'The invoice recipient must be verified before approval.',
      });
      manualReviewReasons.push('Customer name missing');
    }

    if (invoice.total === null) {
      issues.push({
        code: 'MISSING_REQUIRED_FIELD',
        severity: 'warning',
        field: 'total',
        message: 'Required field "total" is missing or unparseable.',
        manualReviewReason: 'Total payable amount cannot be determined.',
      });
      manualReviewReasons.push('Total amount missing');
    }

    for (const field of ['subtotal', 'tax'] as const) {
      if (invoice[field] === null) {
        issues.push({
          code: 'MISSING_CRITICAL_AMOUNT',
          severity: 'error',
          field,
          message: `Critical financial field "${field}" is missing or could not be parsed.`,
          manualReviewReason: `A verified ${field} amount is required before this invoice can be approved.`,
        });
        manualReviewReasons.push(`${field} amount missing`);
      }
    }

    // 2. Currency Validation
    if (!invoice.currency) {
      issues.push({
        code: 'MISSING_CURRENCY',
        severity: 'warning',
        field: 'currency',
        message: 'Invoice currency code is missing; defaulting or cross-currency risks.',
        manualReviewReason: 'Missing currency indicator requires manual account verification.',
      });
      manualReviewReasons.push('Currency not specified');
    }

    // 3. Uncertain Fields Check (Evidence Confidence)
    if (invoice.evidence) {
      for (const [fieldName, ev] of Object.entries(invoice.evidence)) {
        if (ev && typeof ev.confidence === 'number' && ev.confidence < config.uncertaintyThreshold) {
          issues.push({
            code: 'FIELD_UNCERTAIN',
            severity: 'warning',
            field: fieldName,
            message: `Field "${fieldName}" extracted with low confidence (${Math.round(ev.confidence * 100)}%).`,
            actualValue: (invoice as any)[fieldName],
            evidenceSnippet: ev.snippet,
            manualReviewReason: `Low extraction confidence for field "${fieldName}".`,
          });
          manualReviewReasons.push(`Low confidence on ${fieldName}`);
        }
      }
    }

    // 4. Date Format & Future Date Verification
    if (invoice.invoice_date) {
      const parsedDate = parseIsoOrCommonDate(invoice.invoice_date);
      if (!parsedDate || isNaN(parsedDate.getTime())) {
        issues.push({
          code: 'INVALID_DATE_FORMAT',
          severity: 'error',
          field: 'invoice_date',
          message: `Stated invoice date "${invoice.invoice_date}" cannot be parsed into a valid calendar date.`,
          actualValue: invoice.invoice_date,
          manualReviewReason: 'Unparseable invoice date violates ledger standards.',
        });
        manualReviewReasons.push('Invalid invoice date');
      } else {
        const now = new Date();
        const maxFutureMs = now.getTime() + config.futureDateGraceDays * 24 * 60 * 60 * 1000;
        if (parsedDate.getTime() > maxFutureMs) {
          issues.push({
            code: 'FUTURE_DATE_WARNING',
            severity: 'warning',
            field: 'invoice_date',
            message: `Invoice issue date "${invoice.invoice_date}" is in the future beyond ${config.futureDateGraceDays} days grace period.`,
            actualValue: invoice.invoice_date,
            manualReviewReason: 'Post-dated invoice flagged for fiscal authorization.',
          });
          manualReviewReasons.push('Invoice date in the future');
        }
      }
    }

    // 5. Numeric Integrity & Suspicious Amounts Check
    const numericFields: Array<{ name: string; val: number | null }> = [
      { name: 'subtotal', val: invoice.subtotal },
      { name: 'tax', val: invoice.tax },
      { name: 'total', val: invoice.total },
    ];

    for (const numField of numericFields) {
      if (numField.val !== null) {
        if (isNaN(numField.val) || !isFinite(numField.val)) {
          issues.push({
            code: 'INVALID_NUMERIC_VALUE',
            severity: 'error',
            field: numField.name,
            message: `Field "${numField.name}" contains an invalid numeric value: ${numField.val}.`,
            actualValue: numField.val,
          });
        } else if (numField.val < 0 && !config.allowNegativeAmounts) {
          issues.push({
            code: 'NEGATIVE_AMOUNT_SUSPICIOUS',
            severity: 'warning',
            field: numField.name,
            message: `Field "${numField.name}" has negative amount (${numField.val}). Flagged for credit note / refund review.`,
            actualValue: numField.val,
            manualReviewReason: `Suspicious negative ${numField.name} value requires credit memo verification.`,
          });
          manualReviewReasons.push(`Negative ${numField.name} amount`);
        } else if (numField.name === 'total' && numField.val === 0) {
          issues.push({
            code: 'ZERO_AMOUNT_SUSPICIOUS',
            severity: 'warning',
            field: 'total',
            message: 'Invoice total is $0.00; flagged for zero-balance order review.',
            actualValue: 0,
            manualReviewReason: 'Zero-dollar invoice requires manual validation.',
          });
          manualReviewReasons.push('Zero dollar invoice total');
        }
      }
    }

    // 6. Line Item Calculation & Sum versus Subtotal
    let lineItemsCalculatedSum: number | null = null;
    let subtotalDelta: number | null = null;

    if (Array.isArray(invoice.line_items) && invoice.line_items.length > 0) {
      let runningSum = 0;
      let hasValidItemAmounts = false;

      for (let i = 0; i < invoice.line_items.length; i++) {
        const item = invoice.line_items[i];
        const itemFieldPrefix = `line_items[${i}]`;

        // Check quantity * unit_price == amount when all three exist
        if (item.quantity !== null && item.unit_price !== null && item.amount !== null) {
          const expectedItemAmount = multiplyDecimals(item.quantity, item.unit_price);
          const itemDiff = getAbsoluteDelta(expectedItemAmount, item.amount);

          if (itemDiff > config.roundingTolerance) {
            issues.push({
              code: 'LINE_ITEM_CALCULATION_MISMATCH',
              severity: 'error',
              field: `${itemFieldPrefix}.amount`,
              message: `Line item "${item.description || i}" math mismatch: ${item.quantity} × ${item.unit_price} = ${expectedItemAmount}, but amount states ${item.amount}.`,
              actualValue: item.amount,
              expectedValue: expectedItemAmount,
              delta: itemDiff,
              evidenceSnippet: item.evidence,
              manualReviewReason: `Line item "${item.description || i}" arithmetic mismatch.`,
            });
            manualReviewReasons.push(`Line item calculation error on row ${i + 1}`);
          }
        }

        // Accumulate item amount
        if (item.amount !== null && !isNaN(item.amount)) {
          runningSum = addDecimals(runningSum, item.amount);
          hasValidItemAmounts = true;
        }
      }

      if (hasValidItemAmounts) {
        lineItemsCalculatedSum = runningSum;

        if (invoice.subtotal !== null) {
          subtotalDelta = getAbsoluteDelta(lineItemsCalculatedSum, invoice.subtotal);
          if (subtotalDelta > config.roundingTolerance) {
            issues.push({
              code: 'ARITHMETIC_SUBTOTAL_MISMATCH',
              severity: 'error',
              field: 'subtotal',
              message: `Sum of line items (${lineItemsCalculatedSum}) does not match stated subtotal (${invoice.subtotal}). Delta: ${subtotalDelta}.`,
              actualValue: invoice.subtotal,
              expectedValue: lineItemsCalculatedSum,
              delta: subtotalDelta,
              evidenceSnippet: invoice.evidence?.subtotal?.snippet,
              manualReviewReason: `Line items sum (${lineItemsCalculatedSum}) differs from subtotal (${invoice.subtotal}).`,
            });
            manualReviewReasons.push('Line items sum does not equal subtotal');
          }
        }
      }
    } else if (config.requireLineItems) {
      issues.push({
        code: 'MISSING_REQUIRED_FIELD',
        severity: 'warning',
        field: 'line_items',
        message: 'No line items present in invoice; configuration requires itemized lines.',
      });
    }

    // 7. Subtotal + Tax versus Total Financial Reconciliation
    let statedSubtotal = invoice.subtotal;
    let statedTax = invoice.tax;
    let statedTotal = invoice.total;
    let expectedTotal: number | null = null;
    let totalDelta: number | null = null;
    let isReconciled = false;
    let hasRoundingAdjustment = false;

    if (statedSubtotal !== null && statedTotal !== null) {
      const taxComponent = statedTax !== null ? statedTax : 0;
      expectedTotal = addDecimals(statedSubtotal, taxComponent);
      totalDelta = getAbsoluteDelta(statedTotal, expectedTotal);

      if (totalDelta <= config.roundingTolerance) {
        isReconciled = true;
        if (totalDelta > 0) {
          hasRoundingAdjustment = true;
          issues.push({
            code: 'ROUNDING_TOLERANCE_EXCEEDED',
            severity: 'info',
            field: 'total',
            message: `Minor rounding adjustment within tolerance: stated total ${statedTotal} vs subtotal+tax ${expectedTotal} (delta: ${totalDelta}).`,
            actualValue: statedTotal,
            expectedValue: expectedTotal,
            delta: totalDelta,
          });
        }
      } else {
        isReconciled = false;
        issues.push({
          code: 'ARITHMETIC_TOTAL_MISMATCH',
          severity: 'error',
          field: 'total',
          message: `Financial mismatch: Subtotal (${statedSubtotal}) + Tax (${taxComponent}) = ${expectedTotal}, but stated Total is ${statedTotal}. Delta: ${totalDelta}.`,
          actualValue: statedTotal,
          expectedValue: expectedTotal,
          delta: totalDelta,
          evidenceSnippet: invoice.evidence?.total?.snippet,
          manualReviewReason: `Financial reconciliation failed: Subtotal + Tax (${expectedTotal}) != Total (${statedTotal}).`,
        });
        manualReviewReasons.push('Subtotal and tax do not reconcile to total');
      }
    } else if (statedTotal !== null && statedSubtotal === null && statedTax === null) {
      // Single total without itemized subtotal/tax
      isReconciled = true;
      expectedTotal = statedTotal;
    }

    // 8. Duplicate Invoice Candidate Detection
    if (historicalInvoices.length > 0) {
      const duplicateMatch = DuplicateDetector.findDuplicate(invoice, historicalInvoices);
      if (duplicateMatch && duplicateMatch.isDuplicate) {
        issues.push({
          code: 'DUPLICATE_INVOICE_CANDIDATE',
          severity: 'warning',
          field: 'invoice_number',
          message: `Duplicate invoice candidate identified: Supplier "${duplicateMatch.matchedSupplierName}" and invoice #${duplicateMatch.matchedInvoiceNumber}.`,
          actualValue: invoice.invoice_number,
          manualReviewReason: `Potential duplicate submission: ${duplicateMatch.reasons.join(' ')}`,
        });
        manualReviewReasons.push('Potential duplicate invoice candidate');
      }
    }

    // 9. Status Resolution
    const errors = issues.filter(i => i.severity === 'error');
    const warnings = issues.filter(i => i.severity === 'warning');

    let status: ValidationStatus = 'valid';
    if (errors.length > 0) {
      status = 'invalid';
    } else if (warnings.length > 0 || manualReviewReasons.length > 0) {
      status = 'needs_review';
    }

    const reconciliation: FinancialReconciliation = {
      lineItemsCalculatedSum,
      statedSubtotal,
      subtotalDelta,
      statedTax,
      statedTotal,
      expectedTotal,
      totalDelta,
      isReconciled,
      hasRoundingAdjustment,
    };

    return {
      status,
      totalIssues: issues.length,
      errorCount: errors.length,
      warningCount: warnings.length,
      issues,
      errors,
      warnings,
      manualReviewRequired: manualReviewReasons.length > 0 || status === 'needs_review' || status === 'invalid',
      reasonsForManualReview: Array.from(new Set(manualReviewReasons)),
      reconciliation,
      validatedAt: new Date().toISOString(),
    };
  }
}

/**
 * Parses ISO dates (YYYY-MM-DD) or common formats safely.
 */
function parseIsoOrCommonDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const isoMatch = dateStr.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10) - 1;
    const day = parseInt(isoMatch[3], 10);

    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCFullYear() === year && d.getUTCMonth() === month && d.getUTCDate() === day) {
      return d;
    }
    return null; // Invalid day like Feb 31
  }

  const timestamp = Date.parse(dateStr);
  if (isNaN(timestamp)) return null;
  return new Date(timestamp);
}
