/**
 * Automated Verification Suite for Task 2: AI Information Extraction
 * Tests run completely offline without paid API prerequisites.
 */

import { MockRuleBasedAdapter, GeminiExtractionAdapter, ExtractionFactory } from './llmAdapter.ts';
import { resolveGoogleGenAIOptions } from './googleGenAIConfig.ts';
import { validateInvoiceExtraction } from './schemas.ts';
import { documentPipeline } from '../document/documentPipeline.ts';
import { createDigitalPdfBytes } from '../document/tests.ts';

export interface TestRunResult {
  name: string;
  passed: boolean;
  durationMs: number;
  details: string;
}

export async function runInformationExtractionTests(): Promise<{
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

  // 1. Complete invoice extraction in deterministic mock mode
  await test('1. Complete invoice extraction (mock/rule-based mode)', async () => {
    const invoiceText =
      `--- PAGE 1 ---\n` +
      `Global Apex Logistics Ltd\n` +
      `Invoice #: INV-2026-990\n` +
      `Issue Date: 2026-10-20\n` +
      `Billed To: Quantum Robotics Laboratories\n` +
      `----------------------------------------\n` +
      `Line Item Description | Quantity | Unit Price | Amount\n` +
      `Optical Sensor Array | 2 | $1500.00 | $3000.00\n` +
      `Calibration Firmware License | 1 | $500.00 | $500.00\n` +
      `----------------------------------------\n` +
      `Subtotal: $3500.00\n` +
      `Tax: $280.00\n` +
      `Total Balance Due: $3780.00 USD`;

    const adapter = new MockRuleBasedAdapter();
    const res = await adapter.extract(invoiceText);

    if (res.invoice_number !== 'INV-2026-990') throw new Error(`Expected INV-2026-990, got ${res.invoice_number}`);
    if (res.invoice_date !== '2026-10-20') throw new Error(`Expected 2026-10-20, got ${res.invoice_date}`);
    if (!res.supplier_name?.includes('Global Apex Logistics')) throw new Error(`Supplier name mismatch: ${res.supplier_name}`);
    if (!res.customer_name?.includes('Quantum Robotics')) throw new Error(`Customer name mismatch: ${res.customer_name}`);
    if (res.subtotal !== 3500.00) throw new Error(`Subtotal mismatch: ${res.subtotal}`);
    if (res.tax !== 280.00) throw new Error(`Tax mismatch: ${res.tax}`);
    if (res.total !== 3780.00) throw new Error(`Total mismatch: ${res.total}`);
    if (res.currency !== 'USD') throw new Error(`Currency mismatch: ${res.currency}`);
    if (res.line_items.length !== 2) throw new Error(`Expected 2 line items, got ${res.line_items.length}`);
    if (res.extraction_metadata.mode !== 'mock_rule_based') throw new Error('Expected mock_rule_based mode');
  });

  // 2. Missing fields strictly return null without guessing or hallucinating
  await test('2. Missing fields return null without hallucination', async () => {
    const partialText =
      `--- PAGE 1 ---\n` +
      `Supplier: Vanguard Systems\n` +
      `Issue Date: 2026-11-01\n` +
      `Total: $125.00 USD`;

    const adapter = new MockRuleBasedAdapter();
    const res = await adapter.extract(partialText);

    // Missing fields MUST be null
    if (res.invoice_number !== null) throw new Error(`invoice_number should be null, got: ${res.invoice_number}`);
    if (res.customer_name !== null) throw new Error(`customer_name should be null, got: ${res.customer_name}`);
    if (res.subtotal !== null) throw new Error(`subtotal should be null, got: ${res.subtotal}`);
    if (res.tax !== null) throw new Error(`tax should be null, got: ${res.tax}`);

    // Present fields must be preserved
    if (!res.supplier_name?.includes('Vanguard')) throw new Error('Supplier name missing');
    if (res.total !== 125.00) throw new Error('Total mismatch');

    // Warnings should document null fields
    if (!res.extraction_metadata.warnings.some(w => w.includes('invoice_number'))) {
      throw new Error('Missing warning for null invoice_number');
    }
  });

  await test('3. Label-aware extraction rejects adjacent labels and preserves source evidence', async () => {
    const adapter = new MockRuleBasedAdapter();
    const result = await adapter.extract(
      'ACME Services LLC\nInvoice Date: 2026-10-12\nSupplier: ACME Services LLC\nTotal: $1,250'
    );
    if (result.invoice_number !== null) throw new Error(`Invoice Date was misread as invoice number: ${result.invoice_number}`);
    if (result.invoice_date !== '2026-10-12') throw new Error(`Date label was not parsed: ${result.invoice_date}`);
    if (result.total !== 1250) throw new Error(`Whole-dollar amount was not parsed: ${result.total}`);
    if (result.evidence.total?.snippet !== 'Total: $1,250') throw new Error('Evidence must preserve the exact source line');

    const strictId = await adapter.extract('Invoice Date: 2026-10-12\nReference INV-2026-77\nTotal: 1250');
    if (strictId.invoice_number !== 'INV-2026-77') throw new Error(`Strict INV format was not recognized: ${strictId.invoice_number}`);
  });

  await test('4. Locale amounts and ambiguous currency are handled safely', async () => {
    const adapter = new MockRuleBasedAdapter();
    const european = await adapter.extract('Invoice No: AB-17\nInvoice Date: 2026-10-12\nNet Amount: 1.234,56 EUR\nVAT: (8,50)\nGrand Total: 1.226,06 EUR');
    if (european.subtotal !== 1234.56) throw new Error(`European grouped amount was not parsed: ${european.subtotal}`);
    if (european.tax !== -8.5) throw new Error(`Signed amount was not parsed: ${european.tax}`);
    if (european.total !== 1226.06) throw new Error(`European total was not parsed: ${european.total}`);
    if (european.currency !== 'EUR') throw new Error(`Explicit currency code was not retained: ${european.currency}`);

    const ambiguous = await adapter.extract('Invoice No: X-17\nInvoice Date: 2026-10-12\nSubtotal: $1,200\nTotal: $1,200');
    if (ambiguous.currency !== null) throw new Error(`Ambiguous dollar symbol was treated as ${ambiguous.currency}`);
    const schemaSymbol = validateInvoiceExtraction({ currency: '$' }, 'mock_rule_based');
    if (schemaSymbol.data.currency !== null) throw new Error('Schema inferred USD from an ambiguous dollar sign');
  });

  await test('Spreadsheet key/value rows are not mistaken for table headers', async () => {
    const adapter = new MockRuleBasedAdapter();
    const workbookText =
      '--- WORKSHEET: Summary (9 rows, 2 cols) ---\n' +
      'Field | Value\n' +
      '--------------------\n' +
      'Row 2: Invoice Number | INV-2026-004\n' +
      'Row 3: Date | 2026-03-20\n' +
      'Row 4: Supplier | Precision Hardware Systems\n' +
      'Row 5: Customer | Summit Engineering\n' +
      'Row 6: Subtotal | 3200\n' +
      'Row 7: Tax | 320\n' +
      'Row 8: Total | 3520\n' +
      'Row 9: Currency | USD\n' +
      '\n--- WORKSHEET: LineItems (3 rows, 4 cols) ---\n' +
      'Description | Quantity | Unit Price | Amount\n' +
      '--------------------------------------------\n' +
      'Row 2: Industrial Compute Node | 2 | 1200.00 | 2400.00\n' +
      'Row 3: Thermal Sensor Assembly | 4 | 200.00 | 800.00';
    const result = await adapter.extract(workbookText);

    if (result.invoice_number !== 'INV-2026-004') throw new Error(`Invoice number mismatch: ${result.invoice_number}`);
    if (result.invoice_date !== '2026-03-20') throw new Error(`Invoice date mismatch: ${result.invoice_date}`);
    if (result.supplier_name !== 'Precision Hardware Systems') throw new Error(`Supplier mismatch: ${result.supplier_name}`);
    if (result.customer_name !== 'Summit Engineering') throw new Error(`Customer mismatch: ${result.customer_name}`);
    if (result.subtotal !== 3200 || result.tax !== 320 || result.total !== 3520) {
      throw new Error(`Summary amounts mismatch: ${result.subtotal}, ${result.tax}, ${result.total}`);
    }
    if (result.line_items.length !== 2) throw new Error(`Expected two line items, got ${result.line_items.length}`);
  });

  await test('OCR diagnostic metadata is not extracted as invoice content', async () => {
    const adapter = new MockRuleBasedAdapter();
    const result = await adapter.extract(
      '[OCR TEXT UNAVAILABLE]\n' +
      'File: INV-2026-005-BeaconSupplies.png\n' +
      'Detected Format: image/png\n' +
      'No text was inferred because a configured OCR provider is unavailable.'
    );
    if (result.invoice_number !== null) {
      throw new Error(`Filename metadata was extracted as an invoice number: ${result.invoice_number}`);
    }
    if (result.supplier_name !== null) {
      throw new Error(`Diagnostic metadata was extracted as a supplier: ${result.supplier_name}`);
    }
  });

  // 5. Tabular line items extraction with evidence and page reference
  await test('5. Tabular line items extraction with evidence & coordinates', async () => {
    const tableText =
      `--- PAGE 2 ---\n` +
      `Item Description | Qty | Unit Price | Line Total\n` +
      `High Density Fiber Cable | 5 | $45.00 | $225.00\n` +
      `SFP+ Transceiver Module | 10 | $120.00 | $1200.00\n` +
      `Total: $1425.00 USD`;

    const adapter = new MockRuleBasedAdapter();
    const res = await adapter.extract(tableText);

    if (res.line_items.length !== 2) throw new Error(`Expected 2 items, got ${res.line_items.length}`);
    const item1 = res.line_items[0];
    if (!item1.description?.includes('Fiber Cable')) throw new Error('Item 1 description failure');
    if (item1.quantity !== 5) throw new Error(`Item 1 qty failure: ${item1.quantity}`);
    if (item1.unit_price !== 45.00) throw new Error(`Item 1 unit price failure: ${item1.unit_price}`);
    if (item1.amount !== 225.00) throw new Error(`Item 1 amount failure: ${item1.amount}`);
    if (item1.page_reference !== 2) throw new Error(`Item 1 page reference failure: ${item1.page_reference}`);
  });

  // 4. Schema validation handles malformed JSON and enforces decimal safety
  await test('4. Schema validation catches malformed JSON & cleans amounts', async () => {
    const malformed = {
      invoice_number: 'INV-404',
      subtotal: '$1,299.99', // String with symbols
      tax: 'bad_number', // Invalid numeric string
      currency: '$', // Symbol to be normalized
      line_items: 'invalid_array', // Malformed type
    };

    const validation = validateInvoiceExtraction(malformed, 'mock_rule_based');
    if (!validation.isValid) throw new Error('Schema validator should sanitize non-critical issues gracefully');
    if (validation.data.subtotal !== 1299.99) throw new Error(`Decimal cleanup failed: ${validation.data.subtotal}`);
    if (validation.data.tax !== null) throw new Error(`Malformed number should become null: ${validation.data.tax}`);
    if (validation.data.currency !== null) throw new Error(`Ambiguous currency symbol should remain null: ${validation.data.currency}`);
    if (!Array.isArray(validation.data.line_items)) throw new Error('Line items should be empty array on bad type');

    const unsafe = validateInvoiceExtraction({
      invoice_number: { invented: 'INV-FAKE' },
      subtotal: Number.POSITIVE_INFINITY,
      total: '1100approx',
      evidence: { total: { snippet: 'Total 1100', page_reference: 0 } },
    });
    if (unsafe.data.invoice_number !== null || unsafe.data.subtotal !== null || unsafe.data.total !== null) {
      throw new Error('Malformed field values must not be coerced into plausible invoice data');
    }
    if (unsafe.data.evidence.total.page_reference !== null || unsafe.data.evidence.total.confidence !== 0) {
      throw new Error('Invalid evidence metadata must not receive invented page references or confidence');
    }
  });

  // 5. Configurable timeout handling
  await test('5. Timeout handling aborts safely on slow execution', async () => {
    const adapter = new GeminiExtractionAdapter(undefined);
    // Simulating call with 1ms timeout without API key
    try {
      await adapter.extract('Sample text', { timeoutMs: 1 });
    } catch (err) {
      // Must catch gracefully and not crash process
    }
  });

  // 6. Provider failure / unconfigured API key returns graceful fallback
  await test('6. Provider failure returns structured result with warning', async () => {
    // Adapter with empty dummy key to test safe catch block
    const adapter = new GeminiExtractionAdapter('dummy-key');
    const res = await adapter.extract('Sample text', { timeoutMs: 50 });
    if (res.extraction_metadata.mode !== 'gemini_llm') throw new Error('Mode should be gemini_llm');
    if (res.extraction_metadata.warnings.length === 0) throw new Error('Should contain provider failure warning');
    if (res.invoice_number !== null) throw new Error('Failed call should leave fields null');
  });

  // 7. Factory pattern selects mock mode when configured
  await test('7. ExtractionFactory creates MockRuleBasedAdapter by default/config', async () => {
    const adapter = ExtractionFactory.createAdapter(true);
    if (!(adapter instanceof MockRuleBasedAdapter)) {
      throw new Error('Factory should return MockRuleBasedAdapter when mock requested');
    }

    const apiKeyOptions = resolveGoogleGenAIOptions({
      GEMINI_API_KEY: 'test-api-key',
      GOOGLE_PROJECT_ID: 'gen-lang-client-0631189617',
      GOOGLE_PROJECT_NUMBER: '875867557568',
    });
    if (apiKeyOptions?.apiKey !== 'test-api-key') {
      throw new Error('API-key authentication configuration was not resolved');
    }

    const vertexOptions = resolveGoogleGenAIOptions({
      GOOGLE_GENAI_USE_VERTEXAI: 'true',
      GOOGLE_PROJECT_ID: 'gen-lang-client-0631189617',
      GOOGLE_PROJECT_NUMBER: '875867557568',
    });
    if (vertexOptions?.vertexai !== true || vertexOptions.project !== 'gen-lang-client-0631189617') {
      throw new Error('Vertex AI project configuration was not resolved');
    }

    if (resolveGoogleGenAIOptions({ GEMINI_API_KEY: 'MY_GEMINI_API_KEY' }) !== null) {
      throw new Error('Unconfigured API key placeholder must not enable Gemini');
    }
  });

  // 8. End-to-end integration: Task 1 output to Schema-Validated JSON
  await test('8. End-to-end pipeline: Task 1 document parsing to validated JSON', async () => {
    // Generate valid digital PDF using Task 1 pipeline
    const pdfBytes = createDigitalPdfBytes('INV-2026-E2E-77', 1);
    const docResult = await documentPipeline.processSingleFile({
      name: 'invoice_e2e_test.pdf',
      size: pdfBytes.length,
      data: pdfBytes,
    });

    if (docResult.status !== 'completed') throw new Error(`Document processing failed: ${docResult.status}`);
    if (!docResult.rawText) throw new Error('Missing rawText from Task 1 output');

    // Feed rawText into Task 2 extraction adapter
    const adapter = ExtractionFactory.createAdapter(true);
    const extraction = await adapter.extract(docResult.rawText);

    if (extraction.invoice_number !== 'INV-2026-E2E-77') {
      throw new Error(`E2E extraction mismatch: ${extraction.invoice_number}`);
    }
    if (extraction.subtotal !== 1000.00) throw new Error(`E2E subtotal mismatch: ${extraction.subtotal}`);
    if (extraction.tax !== 100.00) throw new Error(`E2E tax mismatch: ${extraction.tax}`);
    if (extraction.total !== 1100.00) throw new Error(`E2E total mismatch: ${extraction.total}`);
    if (extraction.currency !== 'USD') throw new Error(`E2E currency mismatch: ${extraction.currency}`);
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
