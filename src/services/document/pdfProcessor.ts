import type { PDFPageProxy } from 'pdfjs-dist/types/src/display/api.d.ts';
import type { PageViewport } from 'pdfjs-dist/types/src/display/page_viewport.d.ts';
import { PageContent, DocumentMetadata } from './types.ts';
import { OcrResult, OcrService, ocrService } from './ocrService.ts';
import { createOcrImageVariants } from './imagePreprocessor.ts';

export interface PdfProcessingResult {
  pages: PageContent[];
  metadata: Partial<DocumentMetadata>;
  warnings: string[];
  rawText: string;
}

/**
 * Extracts PDF text with PDF.js, including compressed content streams.
 * Documents without readable text are sent to the configured OCR provider.
 */
export async function processPdf(
  buffer: Uint8Array,
  filename: string,
  ocr: Pick<OcrService, 'performOcr'> = ocrService
): Promise<PdfProcessingResult> {
  if (buffer.length < 5 || new TextDecoder().decode(buffer.subarray(0, 5)) !== '%PDF-') {
    throw new Error('Corrupted or invalid PDF format: Missing %PDF- header magic bytes.');
  }

  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    verbosity: 0,
  });
  const pdf = await loadingTask.promise;
  const pages: PageContent[] = [];
  const warnings: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '')
        .join('')
        .trim();

      if (text) {
        const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        pages.push({
          pageNumber,
          text,
          lineCount: lines.length,
          lines,
          isOcr: false,
        });
        page.cleanup();
        continue;
      }

      warnings.push(`Page ${pageNumber} contains no extractable PDF text and was routed to OCR.`);
      const baseViewport = page.getViewport({ scale: 2 });
      const pixelCount = baseViewport.width * baseViewport.height;
      const renderScale = pixelCount > 40_000_000
        ? 2 * Math.sqrt(40_000_000 / pixelCount)
        : 2;
      const viewport = page.getViewport({ scale: renderScale });
      const renderedPage = await renderPdfPage(page, viewport);
      const variants = await createOcrImageVariants(new Uint8Array(renderedPage));
      if (variants.warning) warnings.push(`Page ${pageNumber}: ${variants.warning}`);
      const ocrResult: OcrResult = await ocr.performOcr(
        variants.enhanced,
        { filename: `${filename}#page=${pageNumber}`, mimeType: 'image/png', isScanned: true },
        variants.highContrast
      );
      if (ocrResult.warnings) warnings.push(...ocrResult.warnings.map(warning => `Page ${pageNumber}: ${warning}`));
      const pageText = ocrResult.text;
      const ocrLines = pageText.split(/\r?\n/).filter(line => line.trim());
      pages.push({
        pageNumber,
        text: pageText,
        lineCount: ocrLines.length,
        lines: ocrLines,
        isOcr: true,
        ...(ocrResult.confidence !== null ? { confidence: ocrResult.confidence } : {}),
      });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  const isScanned = pages.some(page => page.isOcr);
  const rawText = pages
    .map(page => `--- PAGE ${page.pageNumber} ---\n${page.text}`)
    .join('\n\n');

  return {
    pages,
    metadata: {
      pageCount: pages.length,
      isScanned,
      hasMultiPages: pages.length > 1,
    },
    warnings,
    rawText,
  };
}

async function renderPdfPage(
  page: PDFPageProxy,
  viewport: PageViewport
): Promise<Uint8Array> {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Unable to create a canvas context for scanned PDF rendering.');
    await page.render({
      canvasContext: context as unknown as Parameters<typeof page.render>[0]['canvasContext'],
      canvas: canvas as unknown as Parameters<typeof page.render>[0]['canvas'],
      viewport,
    }).promise;
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  }

  const canvasPackage = '@napi-rs/canvas';
  const { createCanvas } = await import(/* @vite-ignore */ canvasPackage);
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({
    canvasContext: canvas.getContext('2d') as unknown as Parameters<typeof page.render>[0]['canvasContext'],
    canvas: canvas as unknown as Parameters<typeof page.render>[0]['canvas'],
    viewport,
  }).promise;
  return new Uint8Array(canvas.toBuffer('image/png'));
}
