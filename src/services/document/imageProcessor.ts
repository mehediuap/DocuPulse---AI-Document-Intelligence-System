import { PageContent, DocumentMetadata } from './types.ts';
import { OcrService, ocrService } from './ocrService.ts';
import { createOcrImageVariants } from './imagePreprocessor.ts';

const MAX_TIFF_PAGES = 50;

export interface ImageProcessingResult {
  pages: PageContent[];
  metadata: Partial<DocumentMetadata>;
  warnings: string[];
  rawText: string;
}

/**
 * Image Processor for JPG/JPEG, PNG, and TIFF formats.
 * Supports dimension parsing, multi-page TIFF directory traversal, and OCR extraction.
 */
export async function processImage(
  buffer: Uint8Array,
  filename: string,
  mimeType = 'image/jpeg',
  ocr: Pick<OcrService, 'performOcr'> = ocrService
): Promise<ImageProcessingResult> {
  const warnings: string[] = [];
  const ext = filename.split('.').pop()?.toLowerCase();

  // 1. Validate magic bytes and extract metadata
  const dimensions = parseImageDimensions(buffer);
  const isTiff = ext === 'tif' || ext === 'tiff' || isTiffBuffer(buffer);
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
  const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
  if ((isPng || isJpeg) && (!dimensions || dimensions.width <= 0 || dimensions.height <= 0)) {
    throw new Error('Corrupted image: valid dimensions could not be read from the image header.');
  }

  const pageCount = isTiff ? await getTiffPageCount(buffer) : 1;
  if (pageCount > 1) warnings.push(`Multi-page TIFF detected containing ${pageCount} image directories.`);

  const pages: PageContent[] = [];
  for (let index = 0; index < pageCount; index++) {
    const variants = await createOcrImageVariants(buffer, isTiff ? index : undefined);
    if (variants.warning) warnings.push(`Page ${index + 1}: ${variants.warning}`);
    const ocrResult = await ocr.performOcr(
      variants.enhanced,
      {
        filename,
        mimeType: 'image/png',
        isScanned: true,
      },
      variants.highContrast
    );
    if (ocrResult.warnings) warnings.push(...ocrResult.warnings.map(warning => `Page ${index + 1}: ${warning}`));
    const ocrLines = ocrResult.text.split(/\r?\n/).filter(line => line.trim().length > 0);
    pages.push({
      pageNumber: index + 1,
      text: ocrResult.text,
      lineCount: ocrLines.length,
      lines: ocrLines,
      isOcr: true,
      ...(ocrResult.confidence !== null ? { confidence: ocrResult.confidence } : {}),
    });
  }

  const rawText = pages.map(page => `--- PAGE ${page.pageNumber} ---\n${page.text}`).join('\n\n');

  return {
    pages,
    metadata: {
      dimensions,
      pageCount: pages.length,
      hasMultiPages: pages.length > 1,
      isScanned: true,
    },
    warnings,
    rawText,
  };
}

async function getTiffPageCount(buffer: Uint8Array): Promise<number> {
  const sharpPackage = 'sharp';
  const { default: sharp } = await import(/* @vite-ignore */ sharpPackage);
  const metadata = await sharp(buffer, {
    limitInputPixels: 100_000_000,
    failOn: 'error',
    animated: true,
  }).metadata();
  if (!metadata.pages || metadata.pages < 1) {
    throw new Error('TIFF contains no readable image frames.');
  }
  if (metadata.pages > MAX_TIFF_PAGES) {
    throw new Error(`TIFF has ${metadata.pages} frames; the processing limit is ${MAX_TIFF_PAGES}.`);
  }
  return metadata.pages;
}

/**
 * Checks TIFF magic bytes (Intel II or Motorola MM).
 */
function isTiffBuffer(buf: Uint8Array): boolean {
  if (buf.length < 4) return false;
  const isLittle = buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00;
  const isBig = buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A;
  return isLittle || isBig;
}

/**
 * Parses width and height from PNG, JPEG, or TIFF headers.
 */
function parseImageDimensions(buf: Uint8Array): { width: number; height: number } | undefined {
  if (isTiffBuffer(buf)) {
    const littleEndian = buf[0] === 0x49;
    const read16 = (offset: number) => {
      if (offset < 0 || offset + 2 > buf.length) return undefined;
      return littleEndian ? buf[offset] | (buf[offset + 1] << 8) : (buf[offset] << 8) | buf[offset + 1];
    };
    const read32 = (offset: number) => {
      if (offset < 0 || offset + 4 > buf.length) return undefined;
      return littleEndian
        ? (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0
        : ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
    };
    const ifdOffset = read32(4);
    if (ifdOffset === undefined) return undefined;
    const entryCount = read16(ifdOffset);
    if (entryCount === undefined) return undefined;

    let width: number | undefined;
    let height: number | undefined;
    for (let i = 0; i < entryCount; i++) {
      const entryOffset = ifdOffset + 2 + i * 12;
      const tag = read16(entryOffset);
      const type = read16(entryOffset + 2);
      const count = read32(entryOffset + 4);
      if (tag === undefined || type === undefined || count !== 1) continue;
      const value = type === 3 ? read16(entryOffset + 8) : type === 4 ? read32(entryOffset + 8) : undefined;
      if (tag === 256) width = value;
      if (tag === 257) height = value;
    }
    return width && height ? { width, height } : undefined;
  }

  if (buf.length < 24) return undefined;

  // PNG: Width at byte 16..19, Height at byte 20..23 (Big Endian)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    const width = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
    const height = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
    return { width, height };
  }

  // JPEG: Scan for SOF0 marker (0xFF, 0xC0) or SOF2 (0xFF, 0xC2)
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let offset = 2;
    while (offset < buf.length - 8) {
      if (buf[offset] === 0xFF) {
        const marker = buf[offset + 1];
        // SOF0, SOF1, SOF2 markers contain height and width
        if ((marker >= 0xC0 && marker <= 0xC3) && marker !== 0xC4) {
          const height = (buf[offset + 5] << 8) | buf[offset + 6];
          const width = (buf[offset + 7] << 8) | buf[offset + 8];
          return { width, height };
        }
        const length = (buf[offset + 2] << 8) | buf[offset + 3];
        offset += length + 2;
      } else {
        offset++;
      }
    }
  }

  return undefined;
}
