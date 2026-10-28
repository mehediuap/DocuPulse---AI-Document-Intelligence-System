/**
 * Automated Verification Suite for Task 3: Data Validation
 * Uses synthetic invoice extraction fixtures to verify financial, logical, and business rules.
 */

import { ValidationService } from './validationService.ts';
import { CrossVerificationService } from './crossVerification.ts';
import { InvoiceExtractionResult } from '../extraction/schemas.ts';

export interface TestRunResult {
  name: string;
  passed: boolean;
  durationMs: number;
  details: string;
}

export async function runDataValidationTests(): Promise<{
  total: number;
  passed: number;
  failed: number;
  results: TestRunResult[];
}> {
  const results: TestRunResult[] = [];

  async function test(name: string, fn: () => Promise<void>) {
    const start = performance.now();
    try {
      await fn();
      results.push({
        name,
        passed: true,
        durationMs: Math.round(performance.now() - start),
        details: 'Passed with verified assertions',
      });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      results.push({
        name,
        passed: false,
        durationMs: Math.round(performance.now() - start),
        details: err,
      });
    }
  }

  // Helper fixture generator
  function createBaseInvoice(overrides: Partial<InvoiceExtractionResult> = {}): InvoiceExtractionResult {
    return {
      invoice_number: 'INV-2026-101',
      invoice_date: '2026-10-15',
      supplier_name: 'Apex Precision Technologies Inc.',
      customer_name: 'Starlight Robotics GmbH',
      subtotal: 1000.00,
      tax: 80.00,
      total: 1080.00,
      currency: 'USD',
      line_items: [
        {
          description: 'Industrial Sensor Module',
          quantity: 2,
          unit_price: 500.00,
          amount: 1000.00,
          evidence: 'Sensor Module | 2 | $500.00 | $1000.00',
          page_reference: 1,
        },
      ],
      evidence: {
        total: { snippet: 'Total: $1,080.00 USD', page_reference: 1, confidence: 0.99 },
      },
      extraction_metadata: {
        mode: 'mock_rule_based',
        processing_time_ms: 10,
        warnings: [],
      },
      ...overrides,
    };
  }

  // 1. Valid invoice
  await test('1. Clean, valid invoice passes with "valid" status and zero errors', async () => {
    const inv = createBaseInvoice();
    const res = ValidationService.validateInvoice(inv);

    if (res.status !== 'valid') throw new Error(`Expected status 'valid', got '${res.status}'`);
    if (res.errorCount !== 0) throw new Error(`Expected 0 errors, got ${res.errorCount}`);
    if (res.warningCount !== 0) throw new Error(`Expected 0 warnings, got ${res.warningCount}`);
    if (!res.reconciliation.isReconciled) throw new Error('Expected financial reconciliation to succeed');
  });

  // 2. Missing required fields
  await test('2. Missing required fields require review without being marked invalid', async () => {
    const missingNumber = createBaseInvoice({ invoice_number: null });
    const res = ValidationService.validateInvoice(missingNumber);

    if (res.status !== 'needs_review') throw new Error(`Expected 'needs_review' status, got '${res.status}'`);
    if (!res.warnings.some(e => e.code === 'MISSING_REQUIRED_FIELD' && e.field === 'invoice_number')) {
      throw new Error('Missing invoice_number not captured as a review warning');
    }

    const missingSupplier = createBaseInvoice({ supplier_name: null });
    const resSup = ValidationService.validateInvoice(missingSupplier);
    if (!resSup.warnings.some(e => e.code === 'MISSING_REQUIRED_FIELD' && e.field === 'supplier_name')) {
      throw new Error('Missing supplier_name not captured as a review warning');
    }
    if (resSup.status !== 'needs_review') throw new Error(`Missing supplier should require review, got ${resSup.status}`);
  });

  // 3. Duplicate invoice candidate detection
  await test('3. Duplicate invoice candidate detected via normalized supplier and number', async () => {
    const candidate = createBaseInvoice({
      invoice_number: 'INV-2026-101',
      supplier_name: 'Apex Precision Technologies, Inc.', // Punctuation & casing variation
    });

    const historical = [
      createBaseInvoice({
        invoice_number: '2026-101', // Prefix variation
        supplier_name: 'apex precision technologies',
      }),
    ];

    const res = ValidationService.validateInvoice(candidate, historical);

    if (res.status !== 'needs_review') throw new Error(`Expected 'needs_review', got '${res.status}'`);
    const dupIssue = res.issues.find(i => i.code === 'DUPLICATE_INVOICE_CANDIDATE');
    if (!dupIssue) throw new Error('DUPLICATE_INVOICE_CANDIDATE issue not emitted');
    if (dupIssue.severity !== 'warning') throw new Error('Duplicate candidate should have warning severity');
    if (!res.reasonsForManualReview.some(r => r.includes('duplicate'))) {
      throw new Error('Manual review reasons should contain duplicate notice');
    }
  });

  // 4. Rounding tolerance: acceptable variance vs exceeded threshold
  await test('4. Configurable rounding tolerance handles minor cent variance', async () => {
    // Variance of $0.02 (within default 0.05 tolerance)
    const withinTolerance = createBaseInvoice({
      subtotal: 100.00,
      tax: 8.35,
      total: 108.37, // 100 + 8.35 = 108.35. Delta is $0.02
      line_items: [
        { description: 'Component', quantity: 1, unit_price: 100.00, amount: 100.00 }
      ],
    });

    const resWithin = ValidationService.validateInvoice(withinTolerance, [], { roundingTolerance: 0.05 });
    if (!resWithin.reconciliation.isReconciled) throw new Error('Expected variance of $0.02 to reconcile within 0.05 tolerance');
    if (!resWithin.reconciliation.hasRoundingAdjustment) throw new Error('Expected hasRoundingAdjustment flag to be true');
    if (resWithin.errorCount !== 0) throw new Error('Should not register hard error for within-tolerance variance');

    // Variance of $0.15 (exceeds 0.05 tolerance)
    const exceedsTolerance = createBaseInvoice({
      subtotal: 100.00,
      tax: 8.35,
      total: 108.50, // Delta is $0.15 > 0.05
      line_items: [
        { description: 'Component', quantity: 1, unit_price: 100.00, amount: 100.00 }
      ],
    });

    const resExceeds = ValidationService.validateInvoice(exceedsTolerance, [], { roundingTolerance: 0.05 });
    if (resExceeds.status !== 'invalid') throw new Error(`Expected 'invalid' for exceeded tolerance, got '${resExceeds.status}'`);
    if (!resExceeds.errors.some(e => e.code === 'ARITHMETIC_TOTAL_MISMATCH')) {
      throw new Error('ARITHMETIC_TOTAL_MISMATCH not emitted when tolerance is exceeded');
    }
  });

  // 5. Line items sum versus subtotal arithmetic mismatch
  await test('5. Line items sum versus subtotal arithmetic reconciliation', async () => {
    const mismatch = createBaseInvoice({
      subtotal: 1500.00, // Stated subtotal is 1500
      line_items: [
        { description: 'Item A', quantity: 1, unit_price: 500.00, amount: 500.00 },
        { description: 'Item B', quantity: 1, unit_price: 600.00, amount: 600.00 },
        // Sum is 1100, but subtotal is 1500 -> Delta of 400
      ],
    });

    const res = ValidationService.validateInvoice(mismatch);
    if (res.status !== 'invalid') throw new Error(`Expected 'invalid' for line items sum mismatch, got '${res.status}'`);
    const subtotalIssue = res.errors.find(e => e.code === 'ARITHMETIC_SUBTOTAL_MISMATCH');
    if (!subtotalIssue) throw new Error('ARITHMETIC_SUBTOTAL_MISMATCH error not emitted');
    if (subtotalIssue.severity !== 'error') throw new Error('Confirmed subtotal contradiction must be an error');
    if (subtotalIssue.delta !== 400.00) throw new Error(`Expected delta 400.00, got ${subtotalIssue.delta}`);
  });

  // 6. Suspicious / negative amounts flagged without silent rewriting
  await test('6. Negative or zero amounts flagged for review without silent modification', async () => {
    const negativeInv = createBaseInvoice({
      total: -250.00,
    });

    const res = ValidationService.validateInvoice(negativeInv);
    if (res.status !== 'needs_review' && res.status !== 'invalid') {
      throw new Error(`Expected review or invalid for negative total, got ${res.status}`);
    }
    const negIssue = res.issues.find(i => i.code === 'NEGATIVE_AMOUNT_SUSPICIOUS');
    if (!negIssue) throw new Error('NEGATIVE_AMOUNT_SUSPICIOUS not emitted');
    if (negativeInv.total !== -250.00) throw new Error('Source total was mutated! Never silently rewrite source data.');
  });

  // 7. Missing currency flag
  await test('7. Missing currency flagged with MISSING_CURRENCY warning', async () => {
    const noCurrency = createBaseInvoice({ currency: null });
    const res = ValidationService.validateInvoice(noCurrency);

    if (!res.warnings.some(w => w.code === 'MISSING_CURRENCY')) {
      throw new Error('MISSING_CURRENCY warning was not emitted');
    }
    if (res.status !== 'needs_review') throw new Error(`Expected 'needs_review', got ${res.status}`);
  });

  // 8. Invalid calendar date rejection
  await test('8. Invalid calendar date (e.g. Feb 31) caught as INVALID_DATE_FORMAT', async () => {
    const invalidDate = createBaseInvoice({ invoice_date: '2026-02-31' });
    const res = ValidationService.validateInvoice(invalidDate);

    if (res.status !== 'invalid') throw new Error(`Expected 'invalid' for invalid date, got ${res.status}`);
    if (!res.errors.some(e => e.code === 'INVALID_DATE_FORMAT')) {
      throw new Error('INVALID_DATE_FORMAT error was not emitted');
    }
  });

  // 9. Decimal safety: prevents IEEE-754 precision drift
  await test('9. Decimal safety verified with fractional cents operations (0.1 + 0.2)', async () => {
    const decimalInv = createBaseInvoice({
      subtotal: 0.10,
      tax: 0.20,
      total: 0.30, // 0.10 + 0.20 in IEEE 754 is 0.30000000000000004
      line_items: [
        { description: 'Cent Item', quantity: 1, unit_price: 0.10, amount: 0.10 }
      ]
    });

    const res = ValidationService.validateInvoice(decimalInv);
    if (!res.reconciliation.isReconciled) throw new Error('Decimal safety failed on 0.10 + 0.20 = 0.30');
    if (res.reconciliation.totalDelta !== 0) throw new Error(`Total delta should be exactly 0, got ${res.reconciliation.totalDelta}`);
  });

  // 10. Cross-verification: PDF Invoice vs Excel Purchase Order reconciliation
  await test('10. Cross-verification: PDF Invoice vs Excel PO matches line items and totals', async () => {
    const invoicePdf = createBaseInvoice({
      invoice_number: 'INV-2026-8001',
      supplier_name: 'Starlight Robotics GmbH',
      subtotal: 5000.00,
      tax: 400.00,
      total: 5400.00,
      line_items: [
        { description: 'Robotic Arm Actuator', quantity: 5, unit_price: 1000.00, amount: 5000.00 }
      ],
    });

    const poExcel = createBaseInvoice({
      invoice_number: 'PO-2026-8001',
      supplier_name: 'Starlight Robotics GmbH',
      subtotal: 5000.00,
      tax: 400.00,
      total: 5400.00,
      line_items: [
        { description: 'Robotic Arm Actuator', quantity: 5, unit_price: 1000.00, amount: 5000.00 }
      ],
    });

    const result = CrossVerificationService.crossVerify(invoicePdf, poExcel);
    if (result.matchScorePercent < 85) {
      throw new Error(`Expected high match score, got ${result.matchScorePercent}%`);
    }
    if (!result.financialReconciliation.totalMatched) {
      throw new Error('Total financial reconciliation expected to match');
    }
    if (result.lineItemsReconciliation.matchedCount !== 1) {
      throw new Error(`Expected 1 matched line item, got ${result.lineItemsReconciliation.matchedCount}`);
    }
  });

  // 11. Cross-verification: Discrepancy detection on price/quantity variance
  await test('11. Cross-verification detects price/quantity variances and missing items', async () => {
    const invoice = createBaseInvoice({
      invoice_number: 'INV-DISC-01',
      supplier_name: 'Apex Precision Technologies Inc.',
      total: 1200.00,
      line_items: [
        { description: 'Precision Sensor', quantity: 10, unit_price: 120.00, amount: 1200.00 },
      ],
    });

    const po = createBaseInvoice({
      invoice_number: 'PO-DISC-01',
      supplier_name: 'Apex Precision Technologies Inc.',
      total: 1000.00,
      line_items: [
        { description: 'Precision Sensor', quantity: 10, unit_price: 100.00, amount: 1000.00 },
      ],
    });

    const result = CrossVerificationService.crossVerify(invoice, po);
    if (result.financialReconciliation.totalMatched) {
      throw new Error('Expected total mismatch between 1200 and 1000');
    }
    if (result.lineItemsReconciliation.varianceCount === 0) {
      throw new Error('Expected price variance detection on line item');
    }
    if (!result.discrepancies.some(d => d.field.includes('line_item') || d.field === 'total')) {
      throw new Error('Expected discrepancy entry for line item or total');
    }
  });

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  return {
    total: results.length,
    passed,
    failed,
    results,
  };
}
