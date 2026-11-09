import * as XLSX from 'xlsx';
import { documentPipeline } from './documentPipeline.ts';
import { sanitizeFilename } from './security.ts';
import { processPdf } from './pdfProcessor.ts';
import { OCR_LOW_CONFIDENCE_THRESHOLD, OcrService, ocrService } from './ocrService.ts';
import { processImage } from './imageProcessor.ts';

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

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function createImageOnlyPdfBytes(jpeg: Uint8Array, width: number, height: number): Uint8Array {
  const encoder = new TextEncoder();
  const content = encoder.encode(`q ${width} 0 0 ${height} 0 0 cm /Im1 Do Q`);
  const contentStream = concatBytes([
    encoder.encode(`<< /Length ${content.length} >>\nstream\n`),
    content,
    encoder.encode('\nendstream'),
  ]);
  const imageStream = concatBytes([
    encoder.encode(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
    ),
    jpeg,
    encoder.encode('\nendstream'),
  ]);
  return buildPdf([
    encoder.encode('<< /Type /Catalog /Pages 2 0 R >>'),
    encoder.encode('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    encoder.encode(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      '/Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>'
    ),
    contentStream,
    imageStream,
  ]);
}

async function createTextFixture(
  text: string,
  width = 1_400,
  height = 260,
  fontSize = 74
): Promise<Uint8Array> {
  const sharpPackage = 'sharp';
  const { default: sharp } = await import(/* @vite-ignore */ sharpPackage);
  const svgText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect width="100%" height="100%" fill="white"/>` +
    `<text x="55" y="${Math.round(height * 0.62)}" font-family="Arial, sans-serif" ` +
    `font-size="${fontSize}" font-weight="700" fill="#111">${svgText}</text></svg>`
  );
  return new Uint8Array(await sharp(svg).png().toBuffer());
}

async function createMultiFrameTiff(frames: Uint8Array[]): Promise<Uint8Array> {
  const sharpPackage = 'sharp';
  const { default: sharp } = await import(/* @vite-ignore */ sharpPackage);
  const rawFrames = await Promise.all(frames.map(async frame => {
    const result = await sharp(frame).grayscale().raw().toBuffer({ resolveWithObject: true });
    return {
      pixels: new Uint8Array(result.data),
      width: result.info.width,
      height: result.info.height,
    };
  }));
  const entryCount = 9;
  const ifdSize = 2 + entryCount * 12 + 4;
  const pixelStart = 8 + ifdSize * rawFrames.length;
  const output = new Uint8Array(pixelStart + rawFrames.reduce((sum, frame) => sum + frame.pixels.length, 0));
  const view = new DataView(output.buffer);
  output.set([0x49, 0x49, 0x2a, 0x00], 0);
  view.setUint32(4, 8, true);

  let nextPixelOffset = pixelStart;
  for (let frameIndex = 0; frameIndex < rawFrames.length; frameIndex++) {
    const frame = rawFrames[frameIndex];
    const ifdOffset = 8 + frameIndex * ifdSize;
    view.setUint16(ifdOffset, entryCount, true);
    const entries = [
      [256, 4, frame.width],
      [257, 4, frame.height],
      [258, 3, 8],
      [259, 3, 1],
      [262, 3, 1],
      [273, 4, nextPixelOffset],
      [277, 3, 1],
      [278, 4, frame.height],
      [279, 4, frame.pixels.length],
    ];
    entries.forEach(([tag, type, value], entryIndex) => {
      const offset = ifdOffset + 2 + entryIndex * 12;
      view.setUint16(offset, tag, true);
      view.setUint16(offset + 2, type, true);
      view.setUint32(offset + 4, 1, true);
      if (type === 3) view.setUint16(offset + 8, value, true);
      else view.setUint32(offset + 8, value, true);
    });
    const nextIfdOffset = ifdOffset + 2 + entryCount * 12;
    view.setUint32(nextIfdOffset, frameIndex + 1 < rawFrames.length ? ifdOffset + ifdSize : 0, true);
    output.set(frame.pixels, nextPixelOffset);
    nextPixelOffset += frame.pixels.length;
  }
  return output;
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

  await test('Readable original OCR avoids lower-quality preprocessing variants', async () => {
    const previousProvider = process.env.OCR_PROVIDER;
    process.env.OCR_PROVIDER = 'tesseract';
    let recognizeCalls = 0;
    const ocr = new OcrService(async () => ({
      recognize: async () => {
        recognizeCalls++;
        return { data: { text: 'Readable original transcript', confidence: 83 } };
      },
      terminate: async () => undefined,
    }));
    try {
      const result = await ocr.performOcr(
        new Uint8Array([1]),
        { filename: 'original.png', mimeType: 'image/png' },
        [new Uint8Array([2]), new Uint8Array([3])]
      );
      if (recognizeCalls !== 1) throw new Error(`High-confidence original triggered ${recognizeCalls - 1} unnecessary variants.`);
      if (result.text !== 'Readable original transcript') throw new Error('The original OCR transcript was not retained.');
    } finally {
      await ocr.close();
      if (previousProvider === undefined) delete process.env.OCR_PROVIDER;
      else process.env.OCR_PROVIDER = previousProvider;
    }
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

  await test('Low-confidence local OCR attempts Gemini fallback independently per scanned PDF page', async () => {
    const previousProvider = process.env.OCR_PROVIDER;
    const previousMode = process.env.EXTRACTION_MODE;
    process.env.OCR_PROVIDER = 'gemini';
    process.env.EXTRACTION_MODE = 'gemini';
    let recognizeCalls = 0;
    let geminiCalls = 0;
    const ocr = new OcrService(
      async () => ({
        recognize: async () => {
          recognizeCalls++;
          return { data: { text: `Local page ${recognizeCalls}`, confidence: 20 } };
        },
        terminate: async () => undefined,
      }),
      async () => {
        geminiCalls++;
        throw new Error('Gemini Vision request failed.');
      }
    );

    try {
      const result = await processPdf(createScannedPdfBytes(2), 'scanned.pdf', ocr);
      if (recognizeCalls !== 6 || geminiCalls !== 2 || result.pages.some(page => !page.text.startsWith('Local page'))) {
        throw new Error('Each page must be OCRed locally before its low-confidence Gemini fallback.');
      }
      if (!result.warnings.some(warning => warning.includes('Gemini OCR fallback failed'))) {
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

  const previousProvider = process.env.OCR_PROVIDER;
  const previousMode = process.env.EXTRACTION_MODE;
  process.env.OCR_PROVIDER = 'tesseract';
  process.env.EXTRACTION_MODE = 'mock';

  await test('Gemini OCR fallback is not used without an API key', async () => {
    const previousKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    process.env.OCR_PROVIDER = 'auto';
    const ocr = new OcrService(async () => ({
      recognize: async () => ({ data: { text: 'Local OCR transcript', confidence: 24 } }),
      terminate: async () => undefined,
    }));
    try {
      const result = await ocr.performOcr(new Uint8Array([1]), { filename: 'local-only.png', mimeType: 'image/png' });
      if (result.engineUsed !== 'tesseract' || result.text !== 'Local OCR transcript') {
        throw new Error('Local OCR result was not retained when no Gemini key is configured.');
      }
      if (result.warnings?.some(warning => warning.includes('Gemini'))) {
        throw new Error('Gemini fallback was attempted without an API key.');
      }
    } finally {
      await ocr.close();
      if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousKey;
      process.env.OCR_PROVIDER = 'tesseract';
    }
  });

  await test('Generated clean image uses local OCR and measured confidence', async () => {
    const image = await createTextFixture('INVOICE OCR-CLEAN-503');
    const result = await processImage(image, 'clean.png', 'image/png');
    const page = result.pages[0];
    if (!page.text.includes('OCR-CLEAN-503')) throw new Error(`Clean text was not recognized: ${page.text}`);
    if (typeof page.confidence !== 'number' || page.confidence < 0 || page.confidence > 1) {
      throw new Error(`Expected measured Tesseract confidence in [0, 1], got ${page.confidence}`);
    }
    if (page.isLowQuality !== (page.confidence < OCR_LOW_CONFIDENCE_THRESHOLD)) {
      throw new Error('Page quality flag does not match the measured confidence threshold.');
    }
  });

  await test('Generated skewed and noisy image is deskewed and denoised before local OCR', async () => {
    const sharpPackage = 'sharp';
    const { default: sharp } = await import(/* @vite-ignore */ sharpPackage);
    const clean = await createTextFixture('SKEWED-NOISY-42');
    const noise = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="260">` +
      Array.from({ length: 180 }, (_, index) => {
        const x = (index * 97 + 31) % 1400;
        const y = (index * 53 + 17) % 260;
        return `<circle cx="${x}" cy="${y}" r="2" fill="#777" opacity=".35"/>`;
      }).join('') +
      '</svg>'
    );
    const noisy = new Uint8Array(await sharp(clean)
      .composite([{ input: noise }])
      .rotate(4, { background: '#ffffff' })
      .png()
      .toBuffer());
    const result = await processImage(noisy, 'skewed-noisy.png', 'image/png');
    if (!result.pages[0].text.includes('SKEWED-NOISY-42')) {
      throw new Error(`Skewed/noisy fixture text was not recognized: ${result.pages[0].text}`);
    }
    if (typeof result.pages[0].confidence !== 'number') {
      throw new Error('Skewed/noisy OCR did not return measured Tesseract confidence.');
    }
  });

  await test('Generated low-resolution JPEG is upscaled for local OCR', async () => {
    const sharpPackage = 'sharp';
    const { default: sharp } = await import(/* @vite-ignore */ sharpPackage);
    const source = await createTextFixture('LOWRES JPEG-77', 900, 180, 62);
    const jpeg = new Uint8Array(await sharp(source).resize(180, 36).jpeg({ quality: 35 }).toBuffer());
    const result = await processImage(jpeg, 'low-resolution.jpg', 'image/jpeg');
    if (!result.pages[0].text.includes('LOWRES')) {
      throw new Error(`Low-resolution JPEG text was not recognized: ${result.pages[0].text}`);
    }
    if (typeof result.pages[0].confidence !== 'number') {
      throw new Error('Low-resolution OCR did not return measured Tesseract confidence.');
    }
  });

  await test('Generated blank image is marked low quality without inferred text', async () => {
    const sharpPackage = 'sharp';
    const { default: sharp } = await import(/* @vite-ignore */ sharpPackage);
    const blank = new Uint8Array(await sharp({
      create: { width: 420, height: 160, channels: 3, background: '#ffffff' },
    }).png().toBuffer());
    const result = await processImage(blank, 'blank.png', 'image/png');
    const page = result.pages[0];
    if (typeof page.confidence !== 'number' || page.confidence >= OCR_LOW_CONFIDENCE_THRESHOLD) {
      throw new Error(`Blank image should have a measured low confidence, got ${page.confidence}.`);
    }
    if (!page.isLowQuality) throw new Error('Blank image page was not flagged as low quality.');
    if (page.text.includes('OCR-CLEAN') || page.text.includes('Invoice Number:')) {
      throw new Error('Blank image caused invoice text to be inferred.');
    }
  });

  await test('Generated multi-frame TIFF OCRs each frame and reports progress', async () => {
    const frameOne = await createTextFixture('TIFF-FRAME-1');
    const frameTwo = await createTextFixture('TIFF-FRAME-2');
    const tiff = await createMultiFrameTiff([frameOne, frameTwo]);
    const progress: number[] = [];
    const result = await processImage(
      tiff,
      'two-page.tiff',
      'image/tiff',
      undefined,
      update => progress.push(update.progress)
    );
    if (result.pages.length !== 2) throw new Error(`Expected 2 TIFF frames, got ${result.pages.length}.`);
    if (!result.pages[0].text.includes('TIFF-FRAME-1') || !result.pages[1].text.includes('TIFF-FRAME-2')) {
      throw new Error(`TIFF frame OCR failed: ${result.pages.map(page => page.text).join(' | ')}`);
    }
    if (progress.length !== 2 || progress[1] !== 1) {
      throw new Error(`Expected per-frame progress through 100%, got ${progress.join(', ')}.`);
    }
  });

  await test('Generated image-only PDF rasterizes and OCRs the page independently', async () => {
    const sharpPackage = 'sharp';
    const { default: sharp } = await import(/* @vite-ignore */ sharpPackage);
    const source = await createTextFixture('SCANNED-PDF-9', 1400, 260);
    const jpegResult = await sharp(source).jpeg({ quality: 95 }).toBuffer({ resolveWithObject: true });
    const pdfBytes = createImageOnlyPdfBytes(
      new Uint8Array(jpegResult.data),
      jpegResult.info.width,
      jpegResult.info.height
    );
    const progress: number[] = [];
    const result = await processPdf(
      pdfBytes,
      'scanned-image-only.pdf',
      ocrService,
      update => progress.push(update.progress)
    );
    if (result.pages.length !== 1 || !result.pages[0].isOcr) {
      throw new Error('Image-only PDF page was not independently sent to OCR.');
    }
    if (!result.pages[0].text.includes('SCANNED-PDF-9')) {
      throw new Error(`Scanned PDF text was not recognized: ${result.pages[0].text}`);
    }
    if (typeof result.pages[0].confidence !== 'number') {
      throw new Error('Scanned PDF page did not preserve measured Tesseract confidence.');
    }
    if (progress.length !== 1 || progress[0] !== 1) {
      throw new Error(`Scanned PDF page progress was not reported: ${progress.join(', ')}.`);
    }
  });

  await test('Generated corrupted image is rejected without throwing out of the pipeline', async () => {
    const corrupted = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const result = await documentPipeline.processSingleFile({
      name: 'corrupted-image.png',
      size: corrupted.length,
      data: corrupted,
    });
    if (result.status !== 'failed' || result.errors.length === 0) {
      throw new Error('Corrupted image should return a structured failed document result.');
    }
  });

  await test('A failed OCR page does not fail the rest of a scanned PDF', async () => {
    let ocrCalls = 0;
    const failingPageOcr = {
      performOcr: async (_data: Uint8Array | string, options: { filename?: string }) => {
        ocrCalls++;
        if (options.filename?.endsWith('#page=2')) throw new Error('Synthetic page OCR failure.');
        return {
          text: 'Recovered page one',
          confidence: 0.9,
          engineUsed: 'tesseract' as const,
          wordCount: 3,
          lineCount: 1,
          tested: true,
        };
      },
    };
    const progress: number[] = [];
    const result = await processPdf(
      createScannedPdfBytes(2),
      'fault-isolation.pdf',
      failingPageOcr,
      update => progress.push(update.progress)
    );
    if (ocrCalls !== 2 || result.pages.length !== 2) {
      throw new Error('Both scanned PDF pages must remain represented after one OCR page failure.');
    }
    if (!result.pages[0].text.includes('Recovered page one') || result.pages[1].text !== '') {
      throw new Error('The successful page was lost or the failed page produced an invalid transcript.');
    }
    if (!result.warnings.some(warning => warning.includes('Page 2 ocr failed and was isolated'))) {
      throw new Error('The failed page did not produce an isolation warning.');
    }
    if (progress.length !== 2 || progress[1] !== 1) {
      throw new Error('Progress was not reported after the isolated page failure.');
    }
  });

  try {
    await ocrService.close();
  } finally {
    if (previousProvider === undefined) delete process.env.OCR_PROVIDER;
    else process.env.OCR_PROVIDER = previousProvider;
    if (previousMode === undefined) delete process.env.EXTRACTION_MODE;
    else process.env.EXTRACTION_MODE = previousMode;
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  return {
    total: results.length,
    passed,
    failed,
    results,
  };
}
