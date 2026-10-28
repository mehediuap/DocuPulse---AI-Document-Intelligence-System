/**
 * Cross-Document Verification Service
 * Enables PDF-to-PDF and PDF-to-Excel cross-reconciliation (e.g., Purchase Order vs Invoice,
 * Delivery Log vs Invoice, or dual-source invoice verification).
 */

import { InvoiceExtractionResult, InvoiceLineItem } from '../extraction/schemas.ts';
import { getAbsoluteDelta, toCents, fromCents, isWithinTolerance } from './decimalUtils.ts';
import { normalizeSupplierName, normalizeInvoiceNumber } from './duplicateDetector.ts';

export interface LineItemMatch {
  sourceItem?: InvoiceLineItem;
  targetItem?: InvoiceLineItem;
  descriptionMatchScore: number;
  quantityMatch: boolean;
  quantityDelta: number | null;
  unitPriceMatch: boolean;
  unitPriceDelta: number | null;
  amountMatch: boolean;
  amountDelta: number | null;
  status: 'matched' | 'quantity_variance' | 'price_variance' | 'unmatched_in_target' | 'extra_in_target';
}

export interface CrossVerificationDiscrepancy {
  field: string;
  sourceValue: any;
  targetValue: any;
  delta?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface CrossVerificationResult {
  sourceDocumentId?: string;
  targetDocumentId?: string;
  reconciliationStatus: 'fully_reconciled' | 'reconciled_with_tolerances' | 'discrepancies_found' | 'mismatched';
  matchScorePercent: number; // 0 - 100
  discrepancies: CrossVerificationDiscrepancy[];
  headerReconciliation: {
    invoiceNumberMatch: boolean;
    supplierMatch: boolean;
    customerMatch: boolean;
    dateMatch: boolean;
    currencyMatch: boolean;
  };
  financialReconciliation: {
    sourceTotal: number | null;
    targetTotal: number | null;
    totalDelta: number | null;
    totalMatched: boolean;
    sourceSubtotal: number | null;
    targetSubtotal: number | null;
    subtotalDelta: number | null;
    sourceTax: number | null;
    targetTax: number | null;
    taxDelta: number | null;
  };
  lineItemsReconciliation: {
    totalSourceItems: number;
    totalTargetItems: number;
    matchedCount: number;
    varianceCount: number;
    unmatchedCount: number;
    matches: LineItemMatch[];
  };
  verifiedAt: string;
}

export class CrossVerificationService {
  /**
   * Cross-verifies two invoice extractions (e.g., PDF Invoice vs Excel PO / Delivery Note).
   */
  public static crossVerify(
    source: InvoiceExtractionResult,
    target: InvoiceExtractionResult,
    options: {
      sourceId?: string;
      targetId?: string;
      amountTolerance?: number; // default $0.05
    } = {}
  ): CrossVerificationResult {
    const tolerance = options.amountTolerance ?? 0.05;
    const discrepancies: CrossVerificationDiscrepancy[] = [];

    // 1. Header Cross-Checks
    const normSourceInv = source.invoice_number ? normalizeInvoiceNumber(source.invoice_number) : '';
    const normTargetInv = target.invoice_number ? normalizeInvoiceNumber(target.invoice_number) : '';
    const invoiceNumberMatch = Boolean(
      normSourceInv && normTargetInv &&
      (normSourceInv === normTargetInv || normSourceInv.includes(normTargetInv) || normTargetInv.includes(normSourceInv))
    );

    if (!invoiceNumberMatch && (source.invoice_number || target.invoice_number)) {
      discrepancies.push({
        field: 'invoice_number',
        sourceValue: source.invoice_number,
        targetValue: target.invoice_number,
        severity: 'warning',
        message: `Invoice/PO numbers do not match directly: "${source.invoice_number || 'N/A'}" vs "${target.invoice_number || 'N/A'}".`,
      });
    }

    const normSourceSup = source.supplier_name ? normalizeSupplierName(source.supplier_name) : '';
    const normTargetSup = target.supplier_name ? normalizeSupplierName(target.supplier_name) : '';
    const supplierMatch = Boolean(
      normSourceSup && normTargetSup &&
      (normSourceSup === normTargetSup || normSourceSup.includes(normTargetSup) || normTargetSup.includes(normSourceSup))
    );

    if (!supplierMatch && (source.supplier_name || target.supplier_name)) {
      discrepancies.push({
        field: 'supplier_name',
        sourceValue: source.supplier_name,
        targetValue: target.supplier_name,
        severity: 'error',
        message: `Supplier names mismatch: "${source.supplier_name || 'N/A'}" vs "${target.supplier_name || 'N/A'}".`,
      });
    }

    const customerMatch = Boolean(
      source.customer_name && target.customer_name &&
      normalizeSupplierName(source.customer_name) === normalizeSupplierName(target.customer_name)
    );

    const dateMatch = Boolean(
      source.invoice_date && target.invoice_date &&
      source.invoice_date === target.invoice_date
    );

    const currencyMatch = Boolean(
      source.currency && target.currency &&
      source.currency.toUpperCase() === target.currency.toUpperCase()
    );

    if (!currencyMatch && source.currency && target.currency) {
      discrepancies.push({
        field: 'currency',
        sourceValue: source.currency,
        targetValue: target.currency,
        severity: 'error',
        message: `Currency mismatch between documents: ${source.currency} vs ${target.currency}.`,
      });
    }

    // 2. Financial Amount Cross-Reconciliation
    let totalDelta: number | null = null;
    let totalMatched = false;
    if (source.total !== null && target.total !== null) {
      totalDelta = getAbsoluteDelta(source.total, target.total);
      totalMatched = totalDelta <= tolerance;
      if (!totalMatched) {
        discrepancies.push({
          field: 'total',
          sourceValue: source.total,
          targetValue: target.total,
          delta: totalDelta,
          severity: 'error',
          message: `Total amounts discrepancy: Source states ${source.total}, Target states ${target.total} (delta: ${totalDelta}).`,
        });
      }
    }

    let subtotalDelta: number | null = null;
    if (source.subtotal !== null && target.subtotal !== null) {
      subtotalDelta = getAbsoluteDelta(source.subtotal, target.subtotal);
      if (subtotalDelta > tolerance) {
        discrepancies.push({
          field: 'subtotal',
          sourceValue: source.subtotal,
          targetValue: target.subtotal,
          delta: subtotalDelta,
          severity: 'warning',
          message: `Subtotal amounts differ: Source states ${source.subtotal}, Target states ${target.subtotal} (delta: ${subtotalDelta}).`,
        });
      }
    }

    let taxDelta: number | null = null;
    if (source.tax !== null && target.tax !== null) {
      taxDelta = getAbsoluteDelta(source.tax, target.tax);
      if (taxDelta > tolerance) {
        discrepancies.push({
          field: 'tax',
          sourceValue: source.tax,
          targetValue: target.tax,
          delta: taxDelta,
          severity: 'warning',
          message: `Tax amounts differ: Source states ${source.tax}, Target states ${target.tax} (delta: ${taxDelta}).`,
        });
      }
    }

    // 3. Line Items Cross-Matching
    const sourceItems = source.line_items || [];
    const targetItems = target.line_items || [];
    const matchedTargetIndices = new Set<number>();
    const lineItemMatches: LineItemMatch[] = [];

    for (const sItem of sourceItems) {
      let bestTargetIdx = -1;
      let highestSimilarity = 0;

      for (let tIdx = 0; tIdx < targetItems.length; tIdx++) {
        if (matchedTargetIndices.has(tIdx)) continue;
        const tItem = targetItems[tIdx];
        const sim = computeTextSimilarity(sItem.description || '', tItem.description || '');
        if (sim > highestSimilarity) {
          highestSimilarity = sim;
          bestTargetIdx = tIdx;
        }
      }

      if (bestTargetIdx !== -1 && highestSimilarity >= 0.4) {
        matchedTargetIndices.add(bestTargetIdx);
        const tItem = targetItems[bestTargetIdx];

        const qDelta = (sItem.quantity !== null && tItem.quantity !== null)
          ? Math.abs(sItem.quantity - tItem.quantity)
          : null;
        const qMatch = qDelta !== null ? qDelta === 0 : true;

        const pDelta = (sItem.unit_price !== null && tItem.unit_price !== null)
          ? getAbsoluteDelta(sItem.unit_price, tItem.unit_price)
          : null;
        const pMatch = pDelta !== null ? pDelta <= tolerance : true;

        const aDelta = (sItem.amount !== null && tItem.amount !== null)
          ? getAbsoluteDelta(sItem.amount, tItem.amount)
          : null;
        const aMatch = aDelta !== null ? aDelta <= tolerance : true;

        let status: LineItemMatch['status'] = 'matched';
        if (!qMatch && !pMatch) {
          status = 'price_variance';
        } else if (!qMatch) {
          status = 'quantity_variance';
        } else if (!pMatch) {
          status = 'price_variance';
        }

        if (status !== 'matched') {
          discrepancies.push({
            field: `line_item[${sItem.description || 'item'}]`,
            sourceValue: `${sItem.quantity} @ ${sItem.unit_price} = ${sItem.amount}`,
            targetValue: `${tItem.quantity} @ ${tItem.unit_price} = ${tItem.amount}`,
            severity: 'warning',
            message: `Line item "${sItem.description}": ${status === 'quantity_variance' ? 'Quantity mismatch' : 'Price variance'} between documents.`,
          });
        }

        lineItemMatches.push({
          sourceItem: sItem,
          targetItem: tItem,
          descriptionMatchScore: highestSimilarity,
          quantityMatch: qMatch,
          quantityDelta: qDelta,
          unitPriceMatch: pMatch,
          unitPriceDelta: pDelta,
          amountMatch: aMatch,
          amountDelta: aDelta,
          status,
        });
      } else {
        // Unmatched in target
        lineItemMatches.push({
          sourceItem: sItem,
          descriptionMatchScore: 0,
          quantityMatch: false,
          quantityDelta: null,
          unitPriceMatch: false,
          unitPriceDelta: null,
          amountMatch: false,
          amountDelta: null,
          status: 'unmatched_in_target',
        });

        discrepancies.push({
          field: `line_item[${sItem.description || 'item'}]`,
          sourceValue: sItem.description,
          targetValue: null,
          severity: 'warning',
          message: `Line item "${sItem.description || 'Unnamed'}" present in source but missing in target document.`,
        });
      }
    }

    // Any remaining target items are extra in target
    for (let tIdx = 0; tIdx < targetItems.length; tIdx++) {
      if (!matchedTargetIndices.has(tIdx)) {
        const tItem = targetItems[tIdx];
        lineItemMatches.push({
          targetItem: tItem,
          descriptionMatchScore: 0,
          quantityMatch: false,
          quantityDelta: null,
          unitPriceMatch: false,
          unitPriceDelta: null,
          amountMatch: false,
          amountDelta: null,
          status: 'extra_in_target',
        });

        discrepancies.push({
          field: `line_item[${tItem.description || 'extra'}]`,
          sourceValue: null,
          targetValue: tItem.description,
          severity: 'info',
          message: `Extra line item "${tItem.description || 'Unnamed'}" present in target document.`,
        });
      }
    }

    // 4. Compute Match Score (0 - 100%)
    let points = 0;
    let maxPoints = 0;

    // Header points
    maxPoints += 30;
    if (supplierMatch) points += 15;
    if (invoiceNumberMatch) points += 15;

    // Financial points
    maxPoints += 40;
    if (totalMatched) {
      points += 30;
    } else if (totalDelta !== null && source.total && totalDelta / source.total < 0.05) {
      points += 15;
    }
    if (subtotalDelta !== null && subtotalDelta <= tolerance) points += 10;

    // Line items points
    const matchedCount = lineItemMatches.filter(m => m.status === 'matched').length;
    const varianceCount = lineItemMatches.filter(m => m.status === 'quantity_variance' || m.status === 'price_variance').length;
    const unmatchedCount = lineItemMatches.filter(m => m.status === 'unmatched_in_target' || m.status === 'extra_in_target').length;

    maxPoints += 30;
    if (lineItemMatches.length > 0) {
      const lineItemScore = (matchedCount * 1.0 + varianceCount * 0.5) / lineItemMatches.length;
      points += lineItemScore * 30;
    } else {
      points += 30; // No line items in either to mismatch
    }

    const matchScorePercent = Math.min(100, Math.round((points / maxPoints) * 100));

    // Status Determination
    let reconciliationStatus: CrossVerificationResult['reconciliationStatus'] = 'fully_reconciled';
    const errorCount = discrepancies.filter(d => d.severity === 'error').length;
    const warningCount = discrepancies.filter(d => d.severity === 'warning').length;

    if (errorCount > 0 || matchScorePercent < 50) {
      reconciliationStatus = matchScorePercent < 40 ? 'mismatched' : 'discrepancies_found';
    } else if (warningCount > 0 || (totalDelta !== null && totalDelta > 0)) {
      reconciliationStatus = totalMatched ? 'reconciled_with_tolerances' : 'discrepancies_found';
    }

    return {
      sourceDocumentId: options.sourceId,
      targetDocumentId: options.targetId,
      reconciliationStatus,
      matchScorePercent,
      discrepancies,
      headerReconciliation: {
        invoiceNumberMatch,
        supplierMatch,
        customerMatch,
        dateMatch,
        currencyMatch,
      },
      financialReconciliation: {
        sourceTotal: source.total,
        targetTotal: target.total,
        totalDelta,
        totalMatched,
        sourceSubtotal: source.subtotal,
        targetSubtotal: target.subtotal,
        subtotalDelta,
        sourceTax: source.tax,
        targetTax: target.tax,
        taxDelta,
      },
      lineItemsReconciliation: {
        totalSourceItems: sourceItems.length,
        totalTargetItems: targetItems.length,
        matchedCount,
        varianceCount,
        unmatchedCount,
        matches: lineItemMatches,
      },
      verifiedAt: new Date().toISOString(),
    };
  }
}

/**
 * Computes word-token similarity between two text strings (Jaccard similarity).
 */
function computeTextSimilarity(strA: string, strB: string): number {
  if (!strA || !strB) return 0;
  const tokensA = new Set(strA.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean));
  const tokensB = new Set(strB.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean));

  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }

  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 0 : intersection / union;
}
