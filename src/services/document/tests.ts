import * as XLSX from 'xlsx';
import { documentPipeline } from './documentPipeline.ts';
import { sanitizeFilename } from './security.ts';
import { processPdf } from './pdfProcessor.ts';

// Helper to create a minimal valid digital PDF byte array
export function createDigitalPdfBytes(invoiceNo: string, pages = 1): Uint8Array {
  let content = `%PDF-1.4\n`;
  content += `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  content += `2 0 obj\n<< /Type /Pages /Kids [`;
  for (let i = 1; i <= pages; i++) content += `${2 + i} 0 R `;
  content += `] /Count ${pages} >>\nendobj\n`;

  for (let p = 1; p <= pages; p++) {
    const streamId = 2 + pages + p;
    content += `${2 + p} 0 obj\n<< /Type /Page /Parent 2 0 R /Contents ${streamId} 0 R >>\nendobj\n`;
  }

  for (let p = 1; p <= pages; p++) {
    const textStream = `BT /F1 12 Tf 50 700 Td (Invoice: ${invoiceNo} Page ${p}) Tj ET\nBT /F1 10 Tf 50 680 Td (Supplier: Global Apex Logistics Ltd) Tj ET\nBT /F1 10 Tf 50 660 Td (Subtotal: 1000.00 Tax: 100.00 Total: 1100.00 USD) Tj ET`;
    const streamId = 2 + pages + p;
    content += `${streamId} 0 obj\n<< /Length ${textStream.length} >>\nstream\n${textStream}\nendstream\nendobj\n`;
  }

  content += `xref\n0 ${3 + pages * 2}\n0000000000 65535 f \n`;
  content += `trailer\n<< /Root 1 0 R /Size ${3 + pages * 2} >>\nstartxref\n${content.length}\n%%EOF\n`;
  return new TextEncoder().encode(content);
}

// Helper to create a scanned PDF (no text streams)
export function createScannedPdfBytes(): Uint8Array {
  const content = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n` +
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n` +
    `4 0 obj\n<< /Length 12 >>\nstream\nq 0 0 cm Q\nendstream\nendobj\n` +
    `xref\n0 5\ntrailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF`;
  return new TextEncoder().encode(content);
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

// Helper to create multi-page TIFF header bytes
export function createTiffBytes(isMultiPage = false): Uint8Array {
  const header = [0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00];
  const ifd1 = [
    0x01, 0x00,
    0x00, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x80, 0x07, 0x00, 0x00,
    isMultiPage ? 0x1A : 0x00, 0x00, 0x00, 0x00
  ];

  const ifd2 = isMultiPage ? [
    0x01, 0x00,
    0x00, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x80, 0x07, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00
  ] : [];

  return new Uint8Array([...header, ...ifd1, ...ifd2]);
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

  // 3. Scanned PDF using OCR
  await test('3. Scanned PDF detection and OCR routing', async () => {
    const scannedPdf = createScannedPdfBytes();
    const res = await documentPipeline.processSingleFile({
      name: 'scanned_receipt.pdf',
      size: scannedPdf.length,
      data: scannedPdf,
    });
    if (!res.metadata.isScanned) throw new Error('Scanned PDF was not flagged as isScanned');
    if (!res.pages?.[0].isOcr) throw new Error('Scanned page was not routed to OCR');
    if (res.rawText.includes('Invoice Number:') || res.rawText.includes('Supplier:')) {
      throw new Error('Unavailable OCR must not synthesize invoice values');
    }
  });

  // 4. Image processing (PNG / JPEG)
  await test('4. Image processing (PNG / JPEG) with dimension extraction and OCR', async () => {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x5C, 0x72, 0xA8
    ]);
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

  // 5. Multi-page TIFF support
  await test('5. Multi-page TIFF directory traversal & detection', async () => {
    const tiffBytes = createTiffBytes(true);
    const res = await documentPipeline.processSingleFile({
      name: 'multipage_fax.tiff',
      size: tiffBytes.length,
      data: tiffBytes,
    });
    if (res.fileType !== 'image') throw new Error('Expected image fileType');
    if (res.pages?.length !== 2) throw new Error(`Expected 2 TIFF pages, found ${res.pages?.length}`);
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

  await test('PDF stream scanning handles repeated unterminated stream markers efficiently', async () => {
    const malformedPdf = `%PDF-1.4\n${'stream\n'.repeat(20_000)}xref\ntrailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF`;
    const bytes = new TextEncoder().encode(malformedPdf);
    const start = performance.now();
    await processPdf(bytes, 'malformed-streams.pdf');
    const durationMs = performance.now() - start;
    if (durationMs > 2_000) {
      throw new Error(`Malformed PDF stream scan took too long: ${Math.round(durationMs)}ms`);
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
