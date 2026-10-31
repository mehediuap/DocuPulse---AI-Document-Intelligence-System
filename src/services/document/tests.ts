import * as XLSX from 'xlsx';
import { documentPipeline } from './documentPipeline.ts';
import { sanitizeFilename } from './security.ts';
import { processPdf } from './pdfProcessor.ts';
import { OcrService } from './ocrService.ts';

function buildPdf(objects: Uint8Array[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [encoder.encode('%PDF-1.7\n')];
  const offsets = [0];
  let length = chunks[0].length;
  const append = (chunk: Uint8Array) => {
    chunks.push(chunk);
    length += chunk.length;
  };

  objects.forEach((object, index) => {
    offsets.push(length);
    append(encoder.encode(`${index + 1} 0 obj\n`));
    append(object);
    append(encoder.encode('\nendobj\n'));
  });

  const xrefOffset = length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= objects.length; id++) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  append(encoder.encode(xref));

  const output = new Uint8Array(length);
  let outputOffset = 0;
  for (const chunk of chunks) {
    output.set(chunk, outputOffset);
    outputOffset += chunk.length;
  }
  return output;
}

function createPdfStream(source: Uint8Array, compressed = false): Uint8Array {
  const encoder = new TextEncoder();
  const dictionary = compressed
    ? `<< /Length ${source.length} /Filter /FlateDecode >>\nstream\n`
    : `<< /Length ${source.length} >>\nstream\n`;
  const suffix = '\nendstream';
  const output = new Uint8Array(encoder.encode(dictionary).length + source.length + encoder.encode(suffix).length);
  let offset = 0;
  for (const chunk of [encoder.encode(dictionary), source, encoder.encode(suffix)]) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function createPdfDocument(contentStreams: Uint8Array[]): Uint8Array {
  const pageIds = contentStreams.map((_, index) => 3 + index);
  const fontId = 3 + contentStreams.length;
  const contentIds = contentStreams.map((_, index) => fontId + 1 + index);
  const objects = [
    new TextEncoder().encode('<< /Type /Catalog /Pages 2 0 R >>'),
    new TextEncoder().encode(
      `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
    ),
    ...contentStreams.map((_, index) => new TextEncoder().encode(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`
    )),
    new TextEncoder().encode('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    ...contentStreams,
  ];
  return buildPdf(objects);
}

function escapePdfText(value: string): string {
  return value.replace(/[\\()]/g, '\\$&');
}

// Helper to create a valid digital PDF byte array with page-specific text streams.
export function createDigitalPdfBytes(invoiceNo: string, pages = 1): Uint8Array {
  const encoder = new TextEncoder();
  const streams = Array.from({ length: pages }, (_, index) => {
    const text = [
      `BT /F1 12 Tf 50 700 Td (Invoice Number: ${escapePdfText(invoiceNo)}) Tj ET`,
      `BT /F1 10 Tf 50 680 Td (Page ${index + 1}) Tj ET`,
      'BT /F1 10 Tf 50 660 Td (Supplier: Global Apex Logistics Ltd) Tj ET',
      'BT /F1 10 Tf 50 640 Td (Subtotal: 1000.00 Tax: 100.00 Total: 1100.00 USD) Tj ET',
    ].join('\n');
    return createPdfStream(encoder.encode(text));
  });
  return createPdfDocument(streams);
}

export async function createCompressedPdfBytes(invoiceNo: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const source = encoder.encode(`BT /F1 12 Tf 50 700 Td (${escapePdfText(invoiceNo)}) Tj ET`);
  const compression = new CompressionStream('deflate');
  const writer = compression.writable.getWriter();
  await writer.write(source);
  await writer.close();
  const compressed = new Uint8Array(await new Response(compression.readable).arrayBuffer());
  return createPdfDocument([createPdfStream(compressed, true)]);
}

// Helper to create a scanned PDF (no text streams)
export function createScannedPdfBytes(pageCount = 1): Uint8Array {
  return createPdfDocument(
    Array.from({ length: pageCount }, () => createPdfStream(new TextEncoder().encode('q Q')))
  );
}

// Helper to create valid multi-sheet XLSX buffer
export function createMultiSheetXlsx(): Uint8Array {
  const wb = XLSX.utils.book_new();
  const summaryData = [
    ['Invoice Number', 'Issue Date', 'Customer', 'Total'],
    ['INV-2026-889', '2026-10-15', 'Vertex BioPharma', 14250.00],
    ['INV-2026-890', '2026-10-16', 'Quantum Robotics', 8300.50]
  ];
  const itemsData = [
    ['Item Code', 'Description', 'Quantity', 'Unit Price', 'Amount'],
    ['ITM-01', 'High Precision Actuator', 4, 2500.00, 10000.00],
    ['ITM-02', 'Calibration Sensor Array', 2, 2125.00, 4250.00]
  ];

  const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
  const wsItems = XLSX.utils.aoa_to_sheet(itemsData);

  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');
  XLSX.utils.book_append_sheet(wb, wsItems, 'LineItems');

  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(out);
}

// Helper to create legacy XLS buffer
export function createLegacyXls(): Uint8Array {
  const wb = XLSX.utils.book_new();
  const data = [
    ['Legacy ID', 'Supplier', 'Amount', 'Currency'],
    ['LEG-401', 'Legacy Dynamics Co', 450.75, 'USD']
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'LegacySheet');

  const out = XLSX.write(wb, { type: 'array', bookType: 'biff8' });
  return new Uint8Array(out);
}

export interface TestRunResult {
  name: string;
  passed: boolean;
  durationMs: number;
  details: string;
}

export async function runDocumentProcessingTests(): Promise<{
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

  // 1. Digital PDF extraction with page-level text
  await test('1. Digital PDF page-level text extraction', async () => {
    const pdfBytes = createDigitalPdfBytes('INV-2026-001', 1);
    const res = await documentPipeline.processSingleFile({
      name: 'invoice_digital.pdf',
      size: pdfBytes.length,
      data: pdfBytes,
    });
    if (res.status !== 'completed') throw new Error(`Expected completed status, got: ${res.status}`);
    if (!res.pages || res.pages.length !== 1) throw new Error('Expected 1 page');
    if (!res.rawText.includes('INV-2026-001')) throw new Error('Invoice text not found in extracted output');
    if (res.pages[0].isOcr) throw new Error('Digital PDF should not be flagged as OCR');
  });

  // 2. Multi-page PDF
  await test('2. Multi-page PDF page indexing and boundaries', async () => {
    const pdfBytes = createDigitalPdfBytes('INV-MULTI-PAGE', 3);
    const res = await documentPipeline.processSingleFile({
      name: 'annual_report_3pages.pdf',
      size: pdfBytes.length,
      data: pdfBytes,
    });
    if (res.pages?.length !== 3) throw new Error(`Expected 3 pages, found ${res.pages?.length}`);
    if (res.pages[0].pageNumber !== 1 || res.pages[2].pageNumber !== 3) throw new Error('Page index mismatch');
    if (!res.metadata.hasMultiPages) throw new Error('hasMultiPages metadata should be true');
  });

  await test('PDF.js extracts text from Flate-compressed PDF content streams', async () => {
    const bytes = await createCompressedPdfBytes('INV-COMPRESSED-42');
    const result = await processPdf(bytes, 'compressed-invoice.pdf');
    if (!result.rawText.includes('INV-COMPRESSED-42')) {
      throw new Error('PDF.js did not extract text from the compressed stream.');
    }
    if (result.metadata.isScanned) throw new Error('Compressed digital PDF was incorrectly classified as scanned.');
  });

  // 3. Scanned PDF using OCR
  await test('3. Scanned PDF detection and OCR routing', async () => {
    const scannedPdf = createScannedPdfBytes(2);
    const res = await documentPipeline.processSingleFile({
      name: 'scanned_receipt.pdf',
      size: scannedPdf.length,
      data: scannedPdf,
    });
    if (!res.metadata.isScanned) throw new Error('Scanned PDF was not flagged as isScanned');
    if (res.pages?.length !== 2 || res.pages.some(page => !page.isOcr)) {
      throw new Error('Every scanned PDF page must be independently routed to OCR.');
    }
    if (!res.rawText.includes('--- PAGE 1 ---') || !res.rawText.includes('--- PAGE 2 ---')) {
      throw new Error('Per-page OCR output must preserve both page boundaries.');
    }
    if (res.rawText.includes('Invoice Number:') || res.rawText.includes('Supplier:')) {
      throw new Error('Unavailable OCR must not synthesize invoice values');
    }
  });

  await test('Tesseract provider returns transcript and measured confidence', async () => {
    const previousProvider = process.env.OCR_PROVIDER;
    const previousMode = process.env.EXTRACTION_MODE;
    process.env.OCR_PROVIDER = 'tesseract';
    process.env.EXTRACTION_MODE = 'gemini';
    let terminated = false;
    const ocr = new OcrService(async () => ({
      recognize: async () => ({ data: { text: 'Invoice Number: OCR-42', confidence: 83 } }),
      terminate: async () => { terminated = true; },
    }));

    try {
      const result = await ocr.performOcr(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        filename: 'invoice.png',
        mimeType: 'image/png',
      });
      if (result.engineUsed !== 'tesseract') throw new Error(`Unexpected OCR engine: ${result.engineUsed}`);
      if (!result.text.includes('OCR-42')) throw new Error('OCR transcript was not returned.');
      if (result.confidence !== 0.83) throw new Error(`Expected measured confidence 0.83, got ${result.confidence}`);
    } finally {
      await ocr.close();
      if (previousProvider === undefined) delete process.env.OCR_PROVIDER;
      else process.env.OCR_PROVIDER = previousProvider;
      if (previousMode === undefined) delete process.env.EXTRACTION_MODE;
      else process.env.EXTRACTION_MODE = previousMode;
    }
    if (!terminated) throw new Error('Tesseract worker was not terminated.');
  });

  await test('Tesseract retries the fallback image when the primary variant fails', async () => {
    const previousProvider = process.env.OCR_PROVIDER;
    const previousMode = process.env.EXTRACTION_MODE;
    process.env.OCR_PROVIDER = 'tesseract';
    process.env.EXTRACTION_MODE = 'gemini';
    let recognizeCalls = 0;
    const ocr = new OcrService(async () => ({
      recognize: async () => {
        recognizeCalls++;
        if (recognizeCalls === 1) throw new Error('Unsupported primary image variant.');
        return { data: { text: 'Readable fallback transcript', confidence: 82 } };
      },
      terminate: async () => undefined,
    }));

    try {
      const result = await ocr.performOcr(
        new Uint8Array([1]),
        { filename: 'low-quality.png', mimeType: 'image/png' },
        new Uint8Array([2])
      );
      if (recognizeCalls !== 2) throw new Error(`Expected two OCR variants, got ${recognizeCalls}.`);
      if (!result.text.includes('Readable fallback transcript')) {
        throw new Error('OCR did not return the successful fallback transcript.');
      }
      if (!result.warnings?.some(warning => warning.includes('trying the next available variant'))) {
        throw new Error('OCR fallback failure was not disclosed as a warning.');
      }
    } finally {
      await ocr.close();
      if (previousProvider === undefined) delete process.env.OCR_PROVIDER;
      else process.env.OCR_PROVIDER = previousProvider;
      if (previousMode === undefined) delete process.env.EXTRACTION_MODE;
      else process.env.EXTRACTION_MODE = previousMode;
    }
  });

  await test('Gemini OCR failure falls back to Tesseract for scanned PDF pages', async () => {
    const previousProvider = process.env.OCR_PROVIDER;
    const previousMode = process.env.EXTRACTION_MODE;
    process.env.OCR_PROVIDER = 'gemini';
    process.env.EXTRACTION_MODE = 'gemini';
    let recognizeCalls = 0;
    const ocr = new OcrService(
      async () => ({
        recognize: async () => {
          recognizeCalls++;
          return { data: { text: `Recovered page ${recognizeCalls}`, confidence: 91 } };
        },
        terminate: async () => undefined,
      }),
      async () => {
        throw new Error('Gemini Vision request failed.');
      }
    );

    try {
      const result = await processPdf(createScannedPdfBytes(2), 'scanned.pdf', ocr);
      if (recognizeCalls !== 2 || result.pages.some(page => !page.text.startsWith('Recovered page'))) {
        throw new Error('Scanned PDF pages did not use Tesseract after Gemini failed.');
      }
      if (!result.warnings.some(warning => warning.includes('Gemini OCR failed'))) {
        throw new Error('Gemini OCR failure was not disclosed in the page warnings.');
      }
    } finally {
      await ocr.close();
      if (previousProvider === undefined) delete process.env.OCR_PROVIDER;
      else process.env.OCR_PROVIDER = previousProvider;
      if (previousMode === undefined) delete process.env.EXTRACTION_MODE;
      else process.env.EXTRACTION_MODE = previousMode;
    }
  });

  // 4. Image processing (PNG / JPEG)
  await test('4. Image processing (PNG / JPEG) with dimension extraction and OCR', async () => {
    const sharpPackage = 'sharp';
    const { default: sharp } = await import(/* @vite-ignore */ sharpPackage);
    const pngBytes = new Uint8Array(await sharp({
      create: { width: 256, height: 256, channels: 4, background: '#ffffff' },
    }).png().toBuffer());
    const res = await documentPipeline.processSingleFile({
      name: 'scanned_bill.png',
      size: pngBytes.length,
      data: pngBytes,
    });
    if (res.fileType !== 'image') throw new Error(`Expected fileType image, got ${res.fileType}`);
    if (res.metadata.dimensions?.width !== 256 || res.metadata.dimensions?.height !== 256) {
      throw new Error(`Dimension mismatch: width=${res.metadata.dimensions?.width}, height=${res.metadata.dimensions?.height}`);
    }
    if (!res.pages?.[0].isOcr) throw new Error('Image page should have OCR flagged');
  });

  // 5. TIFF corruption handling
  await test('5. Corrupted TIFF is rejected instead of trusting directory headers', async () => {
    const tiffBytes = new Uint8Array([
      0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x00, 0x01, 0x03, 0x00, 0x01, 0x00,
      0x00, 0x00, 0x80, 0x07, 0x00, 0x00, 0x1A, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]);
    const res = await documentPipeline.processSingleFile({
      name: 'corrupted_fax.tiff',
      size: tiffBytes.length,
      data: tiffBytes,
    });
    if (res.fileType !== 'image') throw new Error('Expected image fileType');
    if (res.status !== 'failed' || res.errors.length === 0) {
      throw new Error('Malformed TIFF directory structure should be rejected.');
    }
  });

  // 6. Multi-worksheet XLSX
  await test('6. Multi-worksheet XLSX boundary and coordinate preservation', async () => {
    const xlsxBytes = createMultiSheetXlsx();
    const res = await documentPipeline.processSingleFile({
      name: 'financial_q3.xlsx',
      size: xlsxBytes.length,
      data: xlsxBytes,
    });
    if (res.fileType !== 'xlsx') throw new Error(`Expected xlsx, got ${res.fileType}`);
    if (res.sheets?.length !== 2) throw new Error(`Expected 2 worksheets, found ${res.sheets?.length}`);
    if (res.sheets[0].sheetName !== 'Summary' || res.sheets[1].sheetName !== 'LineItems') {
      throw new Error('Sheet name preservation failure');
    }
    if (!res.sheets[0].headers.includes('Invoice Number')) throw new Error('Header preservation failure');
    if (res.sheets[1].rowCount !== 3) throw new Error('Row count mismatch');
  });

  // 7. Legacy XLS
  await test('7. Legacy XLS (BIFF8) processing and compatibility warning', async () => {
    const xlsBytes = createLegacyXls();
    const res = await documentPipeline.processSingleFile({
      name: 'archive_2003.xls',
      size: xlsBytes.length,
      data: xlsBytes,
    });
    if (res.fileType !== 'xls') throw new Error(`Expected xls, got ${res.fileType}`);
    if (!res.warnings.some(w => w.includes('Legacy BIFF8'))) throw new Error('Missing legacy XLS compatibility warning');
    if (!res.sheets || res.sheets.length < 1) throw new Error('Failed to parse sheets from legacy XLS');
  });

  // 8. CSV auto-delimited parsing & quoted fields
  await test('8. CSV auto-delimiter detection and RFC-4180 quoted fields', async () => {
    const csvContent =
      `"Transaction ID";"Description";"Amount";"Notes"\n` +
      `"TXN-1001";"Server Hosting, Cloud";"1500.00";"Quarterly; includes backup"\n` +
      `"TXN-1002";"Security Audit";"2200.50";"Complete, verified"`;

    const res = await documentPipeline.processSingleFile({
      name: 'transactions_semicolon.csv',
      size: csvContent.length,
      data: csvContent,
    });
    if (res.fileType !== 'csv') throw new Error('Expected csv type');
    if (res.metadata.detectedDelimiter !== ';') throw new Error(`Expected delimiter ';', got '${res.metadata.detectedDelimiter}'`);
    if (res.sheets?.[0].headers[1] !== 'Description') throw new Error('Failed to parse quoted header');
    if (res.sheets?.[0].rows.length !== 3) throw new Error('Expected 3 rows');
  });

  // 9. Empty file (0 bytes) validation
  await test('9. Empty file (0 bytes) rejected with structured error', async () => {
    const emptyBytes = new Uint8Array(0);
    const res = await documentPipeline.processSingleFile({
      name: 'empty_file.pdf',
      size: 0,
      data: emptyBytes,
    });
    if (res.status !== 'failed') throw new Error(`Expected failed status, got ${res.status}`);
    if (!res.errors.some(e => e.includes('empty (0 bytes)'))) throw new Error('Missing explicit empty file error');
  });

  // 10. Corrupted file safe handling
  await test('10. Corrupted file handles errors gracefully without crashing', async () => {
    const corruptBytes = new TextEncoder().encode('%PDF-Corrupted_Garbage_Header');
    const res = await documentPipeline.processSingleFile({
      name: 'corrupted_invoice.pdf',
      size: corruptBytes.length,
      data: corruptBytes,
    });
    if (res.status !== 'failed') throw new Error(`Corrupted PDF should fail safely, got ${res.status}`);
    if (res.errors.length === 0) throw new Error('Failed document must include error description');
  });

  await test('PDF.js rejects repeated unterminated stream markers efficiently', async () => {
    const malformedPdf = `%PDF-1.4\n${'stream\n'.repeat(20_000)}xref\ntrailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF`;
    const bytes = new TextEncoder().encode(malformedPdf);
    const start = performance.now();
    let rejected = false;
    try {
      await processPdf(bytes, 'malformed-streams.pdf');
    } catch {
      rejected = true;
    }
    const durationMs = performance.now() - start;
    if (!rejected) throw new Error('Malformed PDF was unexpectedly accepted.');
    if (durationMs > 2_000) {
      throw new Error(`Malformed PDF parsing took too long: ${Math.round(durationMs)}ms`);
    }
  });

  // 11. Unsupported format rejection
  await test('11. Unsupported format rejected with informative error', async () => {
    const exeBytes = new TextEncoder().encode('MZ\x90\x00\x03\x00\x00\x00');
    const res = await documentPipeline.processSingleFile({
      name: 'executable_payload.exe',
      size: exeBytes.length,
      data: exeBytes,
    });
    if (res.status !== 'failed') throw new Error('Expected failed status');
    if (!res.errors.some(e => e.includes('Unsupported file format'))) throw new Error('Missing unsupported error');
  });

  // 12. Safe filename handling and path traversal protection
  await test('12. Path traversal and malicious filename sanitization', async () => {
    const unsafeNames = [
      '../../../../etc/passwd.pdf',
      '..\\..\\windows\\system32\\cmd.exe.xlsx',
      'invoice\0nullbyte.png',
      '/var/log/syslog.csv'
    ];
    for (const unsafe of unsafeNames) {
      const sanitized = sanitizeFilename(unsafe);
      if (sanitized.includes('..') || sanitized.includes('/') || sanitized.includes('\\') || sanitized.includes('\0')) {
        throw new Error(`Sanitization failed on: ${unsafe} → ${sanitized}`);
      }
    }
  });

  // 13. Multi-file batch fault-isolation
  await test('13. Multi-file batch fault-isolation (corrupt file does not stop batch)', async () => {
    const validPdf = createDigitalPdfBytes('INV-BATCH-01');
    const emptyFile = new Uint8Array(0);
    const validCsv = 'Name,Amount\nTest,100';

    const batch = [
      { name: 'valid_1.pdf', size: validPdf.length, data: validPdf },
      { name: 'empty_corrupt.pdf', size: 0, data: emptyFile },
      { name: 'valid_2.csv', size: validCsv.length, data: validCsv },
    ];

    const results = await documentPipeline.processBatch(batch);
    if (results.length !== 3) throw new Error(`Expected 3 results, got ${results.length}`);
    if (results[0].status !== 'completed') throw new Error('File 1 should be completed');
    if (results[1].status !== 'failed') throw new Error('File 2 should be failed');
    if (results[2].status !== 'completed' && results[2].status !== 'warning') {
      throw new Error('File 3 should be processed despite File 2 failure');
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
