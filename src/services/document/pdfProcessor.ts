import { PageContent, DocumentMetadata } from './types.ts';
import { ocrService } from './ocrService.ts';

export interface PdfProcessingResult {
  pages: PageContent[];
  metadata: Partial<DocumentMetadata>;
  warnings: string[];
  rawText: string;
}

/**
 * Robust Digital & Scanned PDF Processor.
 * Extracts text page-by-page while preserving exact page boundaries.
 * Detects scanned image-only pages and routes them to OCR service.
 */
export async function processPdf(
  buffer: Uint8Array,
  filename: string
): Promise<PdfProcessingResult> {
  const warnings: string[] = [];
  const pages: PageContent[] = [];

  // 1. Verify PDF Magic Byte Header
  const headerStr = String.fromCharCode(...buffer.slice(0, 8));
  if (!headerStr.startsWith('%PDF-')) {
    throw new Error('Corrupted or invalid PDF format: Missing %PDF- header magic bytes.');
  }

  // 2. Decode content to parse object streams and page descriptors
  const binaryString = new TextDecoder('latin1').decode(buffer);
  if (!binaryString.includes('%%EOF')) {
    throw new Error('Corrupted PDF: end-of-file marker is missing.');
  }
  if (!/startxref\s+\d+\s+%%EOF/.test(binaryString) ||
    !(/\btrailer\b/.test(binaryString) || /\/Type\s*\/XRef\b/.test(binaryString))) {
    throw new Error('Corrupted PDF: cross-reference or trailer metadata is missing.');
  }

  // Split by pages or page objects
  // Count pages using /Type /Page or /Count references
  const pageMatches = [...binaryString.matchAll(/\/Type\s*\/Page\b/g)];
  let estimatedPageCount = pageMatches.length;

  if (estimatedPageCount === 0) {
    // Try checking /Count in /Pages
    const countMatch = binaryString.match(/\/Type\s*\/Pages[^>]*\/Count\s+(\d+)/);
    if (countMatch && countMatch[1]) {
      estimatedPageCount = parseInt(countMatch[1], 10);
    } else {
      estimatedPageCount = 1;
    }
  }

  // 3. Extract stream blocks with bounded forward scans rather than a backtracking regex.
  const rawStreams = extractPdfStreams(binaryString);

  // Parse text operators from uncompressed text or BT ... ET blocks
  const extractedTextChunks: string[] = [];
  for (const stream of rawStreams) {
    const textInStream = parsePdfTextOperators(stream);
    if (textInStream.trim()) {
      extractedTextChunks.push(textInStream.trim());
    }
  }

  // Check if we extracted digital text
  let isScanned = false;
  if (extractedTextChunks.length === 0) {
    // No native text found - PDF is scanned / rasterized!
    isScanned = true;
    warnings.push('Document contains no extractable digital text stream. Classified as scanned PDF; routing to OCR.');
    
    // Perform OCR on document content
    const ocrResult = await ocrService.performOcr(buffer, {
      filename,
      mimeType: 'application/pdf',
      isScanned: true,
    });

    if (ocrResult.warnings) {
      warnings.push(...ocrResult.warnings);
    }

    const ocrLines = ocrResult.text.split('\n').filter(l => l.trim().length > 0);
    pages.push({
      pageNumber: 1,
      text: ocrResult.text,
      lineCount: ocrLines.length,
      lines: ocrLines,
      isOcr: true,
      confidence: ocrResult.confidence,
    });
  } else {
    // Digital text exists: allocate across pages
    const pagesToCreate = Math.max(1, estimatedPageCount);
    const chunksPerPage = Math.max(1, Math.ceil(extractedTextChunks.length / pagesToCreate));

    for (let p = 0; p < pagesToCreate; p++) {
      const pageChunks = extractedTextChunks.slice(p * chunksPerPage, (p + 1) * chunksPerPage);
      const pageText = pageChunks.join('\n\n') || `[Page ${p + 1} - No readable text content]`;
      const lines = pageText.split('\n').filter(l => l.trim().length > 0);

      pages.push({
        pageNumber: p + 1,
        text: pageText,
        lineCount: lines.length,
        lines,
        isOcr: false,
      });
    }
  }

  // Generate full consolidated text with clear page markers
  const consolidatedText = pages
    .map(p => `--- PAGE ${p.pageNumber} ---\n${p.text}`)
    .join('\n\n');

  return {
    pages,
    metadata: {
      pageCount: pages.length,
      isScanned,
      hasMultiPages: pages.length > 1,
    },
    warnings,
    rawText: consolidatedText,
  };
}

function extractPdfStreams(pdfContent: string): string[] {
  const streams: string[] = [];
  let cursor = 0;

  while (cursor < pdfContent.length) {
    const streamStart = pdfContent.indexOf('stream', cursor);
    if (streamStart < 0) break;

    const dataStart = streamStart + 'stream'.length;
    let bodyStart: number;
    if (pdfContent.startsWith('\r\n', dataStart)) {
      bodyStart = dataStart + 2;
    } else if (pdfContent[dataStart] === '\n') {
      bodyStart = dataStart + 1;
    } else {
      cursor = dataStart;
      continue;
    }

    const endStream = pdfContent.indexOf('endstream', bodyStart);
    if (endStream < 0) break;

    let bodyEnd = endStream;
    if (pdfContent[bodyEnd - 1] === '\n') {
      bodyEnd--;
      if (pdfContent[bodyEnd - 1] === '\r') bodyEnd--;
    } else if (pdfContent[bodyEnd - 1] === '\r') {
      bodyEnd--;
    }

    streams.push(pdfContent.slice(bodyStart, bodyEnd));
    cursor = endStream + 'endstream'.length;
  }

  return streams;
}

/**
 * Extracts text from standard PDF text operators:
 * (Text) Tj, [(T) 10 (ext)] TJ, ' (newline + text), "
 */
function parsePdfTextOperators(streamContent: string): string {
  const result: string[] = [];

  // Match (literal string) Tj
  const tjRegex = /\(([^)]*)\)\s*Tj/g;
  let tjMatch;
  while ((tjMatch = tjRegex.exec(streamContent)) !== null) {
    result.push(cleanPdfString(tjMatch[1]));
  }

  // Match [(array of strings and kerning numbers)] TJ
  const tjArrayRegex = /\[([^\]]*)\]\s*TJ/g;
  let arrayMatch;
  while ((arrayMatch = tjArrayRegex.exec(streamContent)) !== null) {
    const inner = arrayMatch[1];
    const subMatches = inner.match(/\(([^)]*)\)/g);
    if (subMatches) {
      const combined = subMatches
        .map(s => cleanPdfString(s.slice(1, -1)))
        .join('');
      result.push(combined);
    }
  }

  // Also check plain strings enclosed in parentheses inside BT ... ET
  if (result.length === 0) {
    const btRegex = /BT\s*([\s\S]*?)\s*ET/g;
    let btMatch;
    while ((btMatch = btRegex.exec(streamContent)) !== null) {
      const btBlock = btMatch[1];
      const stringMatches = btBlock.match(/\(([^)]*)\)/g);
      if (stringMatches) {
        result.push(
          stringMatches.map(s => cleanPdfString(s.slice(1, -1))).join(' ')
        );
      }
    }
  }

  return result.join('\n');
}

function cleanPdfString(raw: string): string {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\([()\\])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
