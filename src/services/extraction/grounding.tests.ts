import assert from 'node:assert/strict';
import { groundExtraction, numbersIn } from './grounding.ts';
import { createEmptyExtractionResult, InvoiceExtractionResult } from './schemas.ts';
import { createSuite, SuiteResult } from '../testing/miniRunner.ts';

const SOURCE = `INVOICE
Invoice No: INV-2026-001
Date: 15/03/2026
Supplier: Acme Supplies Ltd
Bill To: Northwind Traders
Widget A  2 x 50.00  100.00
Widget B  1 x 25.00  25.00
Subtotal: 125.00
Tax: 12.50
Total: 137.50 USD`;

function llm(over: Partial<InvoiceExtractionResult>): InvoiceExtractionResult {
  return { ...createEmptyExtractionResult('gemini_llm'), invoice_number: 'INV-2026-001', invoice_date: '2026-03-15',
    supplier_name: 'Acme Supplies Ltd', customer_name: 'Northwind Traders', subtotal: 125, tax: 12.5, total: 137.5,
    currency: 'USD', line_items: [{ description: 'Widget A', quantity: 2, unit_price: 50, amount: 100 }],
    evidence: { total: { snippet: 'Total: 137.50 USD', page_reference: 1, confidence: 0.9 } }, ...over };
}

export async function runGroundingTests(): Promise<SuiteResult> {
  const { test, finish } = createSuite();

  await test('G1. A fully grounded extraction passes through unchanged', () => {
    const { result, report } = groundExtraction(llm({}), SOURCE);
    assert.deepEqual(report.ungrounded, []);
    assert.equal(result.total, 137.5);
    assert.equal(result.invoice_date, '2026-03-15');          // ISO value matches "15/03/2026" in the source
    assert.equal(result.line_items.length, 1);
  });

  await test('G2. A hallucinated total is removed with a warning and cleared evidence', () => {
    const { result, report } = groundExtraction(llm({ total: 999.99 }), SOURCE);
    assert.equal(result.total, null);
    assert.ok(report.ungrounded.includes('total'));
    assert.equal(result.evidence.total.snippet, null);
    assert.ok(result.extraction_metadata.warnings.some(w => /total/.test(w)));
    assert.equal(result.subtotal, 125);                         // other fields untouched
  });

  await test('G3. Invented supplier / invoice number / customer are removed', () => {
    const { result } = groundExtraction(llm({ supplier_name: 'Globex Corporation', invoice_number: 'INV-777', customer_name: 'Initech' }), SOURCE);
    assert.equal(result.supplier_name, null);
    assert.equal(result.invoice_number, null);
    assert.equal(result.customer_name, null);
  });

  await test('G4. A date that is not in the document is removed; a different format of the same date is accepted', () => {
    assert.equal(groundExtraction(llm({ invoice_date: '2025-01-01' }), SOURCE).result.invoice_date, null);
    assert.equal(groundExtraction(llm({ invoice_date: '2026-03-15' }), 'Issued March 15, 2026').result.invoice_date, '2026-03-15');
  });

  await test('G5. Currency must be printed: USD from a bare "$" is ambiguous and removed; a printed code or € is kept', () => {
    assert.equal(groundExtraction(llm({ currency: 'USD' }), 'Total: $137.50').result.currency, null);
    assert.equal(groundExtraction(llm({ currency: 'USD' }), SOURCE).result.currency, 'USD');
    assert.equal(groundExtraction(llm({ currency: 'EUR' }), 'Total: €137,50').result.currency, 'EUR');
  });

  await test('G6. Invented line-item numbers are nulled and fully-invented items are dropped', () => {
    const { result } = groundExtraction(llm({ line_items: [
      { description: 'Widget A', quantity: 2, unit_price: 77.77, amount: 100 },
      { description: 'Gold bars', quantity: 9, unit_price: 5555, amount: 49995 },
    ] }), SOURCE);
    assert.equal(result.line_items.length, 1);
    assert.equal(result.line_items[0].unit_price, null);
    assert.equal(result.line_items[0].amount, 100);
  });

  await test('G7. Evidence snippets that are not in the document are discarded even if the value is real', () => {
    const { result, report } = groundExtraction(llm({ evidence: { total: { snippet: 'Grand total due: 137.50', page_reference: 1, confidence: 0.95 } } }), SOURCE);
    assert.equal(result.total, 137.5);
    assert.equal(result.evidence.total.snippet, null);
    assert.ok(result.evidence.total.confidence <= 0.3);
    assert.deepEqual(report.weakEvidence, ['total']);
  });

  await test('G8. European and thousands formats are recognised as present in the source', () => {
    assert.ok(numbersIn('Total 1.234,56 EUR').includes(1234.56));
    assert.ok(numbersIn('Total 1,234.56').includes(1234.56));
    assert.ok(numbersIn('Preis 12,50').includes(12.5));
    assert.equal(groundExtraction(llm({ total: 1234.56, subtotal: null, tax: null, line_items: [] }), 'Gesamt: 1.234,56 EUR').result.total, 1234.56);
  });

  await test('G9. Null fields stay null and the input object is not mutated', () => {
    const input = llm({ customer_name: null, total: 999 });
    const snapshot = JSON.stringify(input);
    const { result } = groundExtraction(input, SOURCE);
    assert.equal(result.customer_name, null);
    assert.equal(JSON.stringify(input), snapshot);
  });

  return finish();
}
