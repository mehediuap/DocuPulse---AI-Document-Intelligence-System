import assert from 'node:assert/strict';
import { ValidationService } from './validationService.ts';
import { createEmptyExtractionResult, InvoiceExtractionResult } from '../extraction/schemas.ts';
import { createSuite, SuiteResult } from '../testing/miniRunner.ts';

function inv(over: Partial<InvoiceExtractionResult>): InvoiceExtractionResult {
  return { ...createEmptyExtractionResult('mock_rule_based'), invoice_number: 'INV-1', invoice_date: '2026-03-15',
    supplier_name: 'Acme Ltd', currency: 'USD', ...over };
}
const codes = (r: ReturnType<typeof ValidationService.validateInvoice>) => r.issues.map(i => i.code);

export async function runReconciliationTests(): Promise<SuiteResult> {
  const { test, finish } = createSuite();

  await test('V1. subtotal + tax = total still reconciles; a real mismatch is still an error', () => {
    const ok = ValidationService.validateInvoice(inv({ subtotal: 100, tax: 10, total: 110 }));
    assert.equal(ok.reconciliation.isReconciled, true);
    const bad = ValidationService.validateInvoice(inv({ subtotal: 100, tax: 10, total: 150 }));
    assert.equal(bad.status, 'invalid');
    assert.ok(codes(bad).includes('ARITHMETIC_TOTAL_MISMATCH'));
  });

  await test('V2. Missing tax is NOT treated as 0: total above subtotal -> needs_review warning, not an arithmetic error', () => {
    const r = ValidationService.validateInvoice(inv({ subtotal: 100, tax: null, total: 110 }));
    assert.equal(r.status, 'needs_review');
    assert.ok(codes(r).includes('TAX_MISSING_CANNOT_RECONCILE'));
    assert.ok(!codes(r).includes('ARITHMETIC_TOTAL_MISMATCH'));
    assert.equal(r.reconciliation.isReconciled, false);
  });

  await test('V3. Missing tax with total equal to subtotal (tax-free invoice) reconciles', () => {
    const r = ValidationService.validateInvoice(inv({ subtotal: 100, tax: null, total: 100 }));
    assert.equal(r.reconciliation.isReconciled, true);
    assert.ok(!codes(r).includes('TAX_MISSING_CANNOT_RECONCILE'));
  });

  await test('V4. Missing subtotal: line items + tax are checked against the total', () => {
    const lines = [{ description: 'A', quantity: 2, unit_price: 50, amount: 100 }];
    const ok = ValidationService.validateInvoice(inv({ subtotal: null, tax: 10, total: 110, line_items: lines }));
    assert.equal(ok.reconciliation.isReconciled, true);
    const bad = ValidationService.validateInvoice(inv({ subtotal: null, tax: 10, total: 140, line_items: lines }));
    assert.equal(bad.status, 'invalid');
    assert.ok(codes(bad).includes('ARITHMETIC_TOTAL_MISMATCH'));
  });

  await test('V5. Only a total: reported as unverifiable (isReconciled=false + info), not "reconciled"', () => {
    const r = ValidationService.validateInvoice(inv({ subtotal: null, tax: null, total: 110 }));
    assert.equal(r.reconciliation.isReconciled, false);
    assert.ok(codes(r).includes('RECONCILIATION_NOT_POSSIBLE'));
    assert.equal(r.issues.find(i => i.code === 'RECONCILIATION_NOT_POSSIBLE')?.severity, 'info');
  });

  return finish();
}
