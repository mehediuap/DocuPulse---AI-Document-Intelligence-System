/**
 * Lightweight PDF text extraction (no external PDF library).
 *
 * What it handles:
 *  - uncompressed and FlateDecode (zlib) content streams, i.e. what most generators emit
 *  - real page attribution via /Pages /Kids order and each page's /Contents references
 *  - scanned PDFs (no text operators) are routed to the OCR service
 *
 * What it does NOT handle (use pdf.js / MuPDF / PyMuPDF for production-grade parsing):
 *  - object streams (/Type /ObjStm), encrypted PDFs, LZW/ASCII85/other filters
 *  - fonts with custom encodings (CID / Identity-H / ToUnicode): their text can come out as codes
 *  - reading order for complex layouts
 *
 * Safety: every scan is linear in the file size (no nested lazy regexes), and decompression is capped
 * per stream and in total so a crafted file cannot hang the event loop or exhaust memory.
 */

import { Buffer } from 'node:buffer';
import zlib from 'node:zlib';
import type { PDFPageProxy } from 'pdfjs-dist/types/src/display/api.d.ts';
import type { PageViewport } from 'pdfjs-dist/types/src/display/page_viewport.d.ts';
import {
  DocumentProcessingProgress,
  DocumentMetadata,
  PageContent,
} from './types.ts';
import {
  OCR_LOW_CONFIDENCE_THRESHOLD,
  OcrResult,
  OcrService,
  ocrService,
} from './ocrService.ts';
import { createOcrImageVariants } from './imagePreprocessor.ts';

export interface PdfProcessingResult {
  pages: PageContent[];
  metadata: Partial<DocumentMetadata>;
  warnings: string[];
  rawText: string;
}

export const PDF_LIMITS = {
  maxStreams: 50_000,
  maxInflatedPerStream: 8 * 1024 * 1024,
  maxInflatedTotal: 128 * 1024 * 1024,
  maxScanPerStream: 4 * 1024 * 1024,
  maxPages: 20_000,
  dictLookback: 1024,
};

interface PdfStream {
  objNum: number | null;
  dict: string;
  data: Buffer;
}

export async function processPdf(
  buffer: Uint8Array,
  filename: string,
  ocr: Pick<OcrService, 'performOcr'> = ocrService,
  onProgress?: (progress: DocumentProcessingProgress) => void
): Promise<PdfProcessingResult> {
  const warnings: string[] = [];
  const pages: PageContent[] = [];

  const headerStr = String.fromCharCode(...buffer.slice(0, 8));
  if (!headerStr.startsWith('%PDF-')) {
    throw new Error('Corrupted or invalid PDF format: Missing %PDF- header magic bytes.');
  }

  const buf = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const binaryString = buf.toString('latin1');
  if (!binaryString.includes('%%EOF')) {
    throw new Error('Corrupted PDF: end-of-file marker is missing.');
  }
  if (!/startxref\s+\d+\s+%%EOF/.test(binaryString) ||
    !(/\btrailer\b/.test(binaryString) || /\/Type\s*\/XRef\b/.test(binaryString))) {
    throw new Error('Corrupted PDF: cross-reference or trailer metadata is missing.');
  }

  const streams = findStreams(buf, warnings);
  const textByObj = new Map<number, string>();
  const extractedTextChunks: string[] = [];
  for (const s of streams) {
    const lines = extractTextLines(s.data.toString('latin1', 0, Math.min(s.data.length, PDF_LIMITS.maxScanPerStream)));
    if (lines.length === 0) continue;
    const text = lines.join('\n');
    extractedTextChunks.push(text);
    if (s.objNum !== null) textByObj.set(s.objNum, text);
  }

  const mapped = mapTextToPages(binaryString, textByObj);
  let pageTexts = mapped;
  let pageCount = mapped?.length ?? 0;
  let approximateTextPages = false;
  if (pageCount === 0) {
    pageCount = [...binaryString.matchAll(/\/Type\s*\/Page\b/g)].length;
    if (pageCount === 0) {
      const countMatch = binaryString.match(/\/Type\s*\/Pages[^>]*\/Count\s+(\d+)/);
      pageCount = countMatch ? Number(countMatch[1]) : 1;
    }
    if (pageCount > PDF_LIMITS.maxPages) {
      warnings.push(`PDF page count exceeds the supported limit of ${PDF_LIMITS.maxPages}; remaining pages were omitted.`);
      pageCount = PDF_LIMITS.maxPages;
    }
    if (extractedTextChunks.length > 0) {
      approximateTextPages = true;
      const chunksPerPage = Math.max(1, Math.ceil(extractedTextChunks.length / pageCount));
      pageTexts = Array.from({ length: pageCount }, (_, index) =>
        extractedTextChunks.slice(index * chunksPerPage, (index + 1) * chunksPerPage).join('\n\n') ||
        `[Page ${index + 1} - No readable text content]`
      );
      warnings.push('Page structure could not be resolved; text was distributed approximately.');
    } else {
      pageTexts = Array.from({ length: pageCount }, () => '');
    }
  }

  if (pageCount > PDF_LIMITS.maxPages) {
    warnings.push(`PDF page count exceeds the supported limit of ${PDF_LIMITS.maxPages}; remaining pages were omitted.`);
    pageCount = PDF_LIMITS.maxPages;
  }

  let loadingTask: {
    promise: Promise<{ numPages: number; getPage: (pageNumber: number) => Promise<PDFPageProxy> }>;
    destroy: () => Promise<void>;
  } | undefined;
  let pdf: { numPages: number; getPage: (pageNumber: number) => Promise<PDFPageProxy> } | undefined;
  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const pageText = pageTexts?.[pageNumber - 1] ?? '';
      let stage: DocumentProcessingProgress['stage'] = 'text-extraction';
      let page: PDFPageProxy | undefined;
      try {
        let extractedPageText = pageText;
        if (!extractedPageText && !approximateTextPages) {
          stage = 'ocr';
          if (!loadingTask) {
            const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
            loadingTask = getDocument({
              data: new Uint8Array(buffer),
              useSystemFonts: true,
              verbosity: 0,
            });
          }
          pdf ??= await loadingTask.promise;
          if (pageNumber > pdf.numPages) {
            throw new Error(`PDF.js reports only ${pdf.numPages} pages.`);
          }
          page = await pdf.getPage(pageNumber);
          const textContent = await page.getTextContent();
          extractedPageText = textContent.items
            .map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '')
            .join('')
            .trim();

          if (!extractedPageText) {
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
            const deskewApplied = variants.deskewedOriginal !== variants.original;
            const ocrResult: OcrResult = await ocr.performOcr(
              deskewApplied ? variants.deskewedOriginal : variants.original,
              { filename: `${filename}#page=${pageNumber}`, mimeType: 'image/png', isScanned: true },
              deskewApplied
                ? [variants.original, variants.enhanced, variants.highContrast]
                : [variants.enhanced, variants.highContrast]
            );
            if (ocrResult.warnings) {
              warnings.push(...ocrResult.warnings.map(warning => `Page ${pageNumber}: ${warning}`));
            }
            const ocrLines = ocrResult.text.split(/\r?\n/).filter(line => line.trim());
            const isLowQuality = ocrResult.confidence === null ||
              ocrResult.confidence < OCR_LOW_CONFIDENCE_THRESHOLD;
            if (ocrResult.confidence === null) {
              warnings.push(`Page ${pageNumber} OCR confidence is unavailable; manual review is recommended.`);
            } else if (isLowQuality) {
              warnings.push(
                `Page ${pageNumber} OCR confidence is below the ${Math.round(OCR_LOW_CONFIDENCE_THRESHOLD * 100)}% quality threshold.`
              );
            }
            pages.push({
              pageNumber,
              text: ocrResult.text,
              lineCount: ocrLines.length,
              lines: ocrLines,
              isOcr: true,
              confidence: ocrResult.confidence,
              isLowQuality,
            });
            continue;
          }
        }

        const lines = extractedPageText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        pages.push({
          pageNumber,
          text: extractedPageText,
          lineCount: lines.length,
          lines,
          isOcr: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Page ${pageNumber} ${stage} failed and was isolated: ${message}`);
        pages.push({
          pageNumber,
          text: '',
          lineCount: 0,
          lines: [],
          isOcr: stage === 'ocr',
          ...(stage === 'ocr' ? { confidence: null, isLowQuality: true } : {}),
        });
      } finally {
        page?.cleanup();
        onProgress?.({
          pageNumber,
          totalPages: pageCount,
          completedPages: pageNumber,
          progress: pageNumber / pageCount,
          stage,
        });
      }
    }
  } finally {
    await loadingTask?.destroy();
  }

  const consolidatedText = pages
    .map(p => `--- PAGE ${p.pageNumber} ---\n${p.text}`)
    .join('\n\n');

  return {
    pages,
    metadata: {
      pageCount: pages.length,
      isScanned: pages.some(page => page.isOcr),
      hasMultiPages: pages.length > 1,
    },
    warnings,
    rawText: consolidatedText,
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

/* ----------------------------------------------------------------------------------------------- */
/* Stream discovery (linear: Buffer.indexOf only, no backtracking regexes over the whole file)       */
/* ----------------------------------------------------------------------------------------------- */

const SKIP_DICT = /\/Subtype\s*\/Image|\/Type\s*\/(?:XRef|ObjStm|Metadata)|\/Length1\b|\/FontFile/;

export function findStreams(buf: Buffer, warnings: string[]): PdfStream[] {
  const out: PdfStream[] = [];
  let pos = 0;
  let inflatedTotal = 0;
  let undecodable = 0;
  let oversize = 0;

  while (out.length < PDF_LIMITS.maxStreams) {
    const kw = buf.indexOf('stream', pos, 'latin1');
    if (kw < 0) break;
    if (kw >= 3 && buf.toString('latin1', kw - 3, kw) === 'end') { pos = kw + 6; continue; }

    let dataStart = kw + 6;
    if (buf[dataStart] === 0x0d && buf[dataStart + 1] === 0x0a) dataStart += 2;
    else if (buf[dataStart] === 0x0a || buf[dataStart] === 0x0d) dataStart += 1;
    else { pos = kw + 6; continue; }                         // not a stream keyword

    const end = buf.indexOf('endstream', dataStart, 'latin1');
    if (end < 0) {
      if (buf.indexOf('stream\n', kw + 6, 'latin1') >= 0 ||
        buf.indexOf('stream\r\n', kw + 6, 'latin1') >= 0) {
        throw new Error('Malformed PDF: an unterminated stream is followed by another stream marker.');
      }
      warnings.push('Truncated PDF stream (missing endstream) ignored.');
      break;
    }
    pos = end + 9;

    // Dictionary preceding the keyword: look back a short, bounded distance for "N G obj"
    const head = buf.toString('latin1', Math.max(0, kw - PDF_LIMITS.dictLookback), kw);
    let objNum: number | null = null;
    let dict = head;
    const objRe = /(\d+)\s+\d+\s+obj\b/g;
    let m: RegExpExecArray | null;
    let last: RegExpExecArray | null = null;
    while ((m = objRe.exec(head)) !== null) last = m;
    if (last) { objNum = Number(last[1]); dict = head.slice(last.index + last[0].length); }

    if (SKIP_DICT.test(dict)) continue;

    let dataEnd = end;
    if (buf[dataEnd - 1] === 0x0a) dataEnd--;
    if (buf[dataEnd - 1] === 0x0d) dataEnd--;
    let data = buf.subarray(dataStart, Math.max(dataStart, dataEnd));

    const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1];
    if (filter) {
      const names = filter.match(/\/\w+/g) || [];
      if (inflatedTotal >= PDF_LIMITS.maxInflatedTotal) { oversize++; continue; }
      try {
        for (const name of names) {
          if (name === '/FlateDecode') {
            // maxOutputLength throws a RangeError for decompression bombs
            data = zlib.inflateSync(data, { maxOutputLength: PDF_LIMITS.maxInflatedPerStream });
          } else if (name === '/ASCII85Decode') {
            data = decodeAscii85(data, PDF_LIMITS.maxInflatedPerStream);
          } else if (name === '/ASCIIHexDecode') {
            data = decodeAsciiHex(data);
          } else {
            throw new Error(`unsupported filter ${name}`);
          }
        }
        inflatedTotal += data.length;
      } catch {
        undecodable++;                                       // unsupported, corrupt, or too large
        continue;
      }
    }
    out.push({ objNum, dict, data });
  }

  if (undecodable > 0) warnings.push(`${undecodable} PDF stream(s) used an unsupported/corrupt/oversized encoding and were skipped.`);
  if (oversize > 0) warnings.push(`${oversize} PDF stream(s) skipped: total decompressed size limit reached.`);
  return out;
}

export function decodeAscii85(input: Buffer, maxOut: number): Buffer {
  let text = input.toString('latin1');
  const start = text.startsWith('<~') ? 2 : 0;
  const endMark = text.indexOf('~>');
  text = text.slice(start, endMark >= 0 ? endMark : undefined);
  const out: number[] = [];
  let group: number[] = [];
  const flush = (count: number) => {
    const padded = group.concat(new Array(5 - group.length).fill(84));   // pad with 'u'
    let v = 0;
    for (const d of padded) v = v * 85 + d;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    for (let k = 0; k < count; k++) out.push(bytes[k]);
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 32 || ch === 10 || ch === 13 || ch === 9 || ch === 12 || ch === 0) continue;
    if (ch === 122 && group.length === 0) { out.push(0, 0, 0, 0); }      // 'z' = four zero bytes
    else if (ch >= 33 && ch <= 117) {
      group.push(ch - 33);
      if (group.length === 5) { flush(4); group = []; }
    } else throw new Error('invalid ASCII85 data');
    if (out.length > maxOut) throw new RangeError('ASCII85 output too large');
  }
  if (group.length > 1) flush(group.length - 1);
  return Buffer.from(out);
}

export function decodeAsciiHex(input: Buffer): Buffer {
  const text = input.toString('latin1').replace(/>.*$/s, '').replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]*$/.test(text)) throw new Error('invalid ASCIIHex data');
  return Buffer.from(text.length % 2 ? text + '0' : text, 'hex');
}

/* ----------------------------------------------------------------------------------------------- */
/* Page tree -> text per page                                                                        */
/* ----------------------------------------------------------------------------------------------- */

interface PageNode { kind: 'page' | 'pages'; kids: number[]; contents: number[]; hasParent: boolean; order: number }

/** Returns one text per page in document order, or null if the page tree cannot be resolved. */
export function mapTextToPages(pdf: string, textByObj: Map<number, string>): string[] | null {
  const nodes = new Map<number, PageNode>();
  const re = /\/Type\s*\/(Pages|Page)\b/g;
  let m: RegExpExecArray | null;
  let order = 0;
  while ((m = re.exec(pdf)) !== null) {
    const from = Math.max(0, m.index - 1024);
    const before = pdf.slice(from, m.index);
    const objRe = /(\d+)\s+\d+\s+obj\b/g;
    let o: RegExpExecArray | null;
    let last: RegExpExecArray | null = null;
    while ((o = objRe.exec(before)) !== null) last = o;
    if (!last) continue;
    const num = Number(last[1]);
    const bodyStart = from + last.index + last[0].length;
    const endObj = pdf.indexOf('endobj', m.index);
    const body = pdf.slice(bodyStart, endObj < 0 || endObj - bodyStart > 8192 ? bodyStart + 8192 : endObj);

    const refs = (value: string | undefined) => value ? [...value.matchAll(/(\d+)\s+\d+\s+R\b/g)].map(r => Number(r[1])) : [];
    const kids = refs(/\/Kids\s*\[([^\]]*)\]/.exec(body)?.[1]);
    const contents = refs(/\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(body)?.[1]);
    nodes.set(num, { kind: m[1] === 'Pages' ? 'pages' : 'page', kids, contents, hasParent: /\/Parent\s+\d+\s+\d+\s+R/.test(body), order: order++ });
  }
  const pageNodes = [...nodes.entries()].filter(([, n]) => n.kind === 'page');
  if (pageNodes.length === 0) return null;

  // Prefer the page tree order (/Kids); fall back to file order.
  let ordered: number[] = [];
  const roots = [...nodes.entries()].filter(([, n]) => n.kind === 'pages' && !n.hasParent).map(([k]) => k);
  const walk = (num: number, depth: number) => {
    const n = nodes.get(num);
    if (!n || depth > 32 || ordered.length > PDF_LIMITS.maxPages) return;
    if (n.kind === 'page') { ordered.push(num); return; }
    for (const kid of n.kids) walk(kid, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  if (ordered.length !== pageNodes.length || new Set(ordered).size !== ordered.length) {
    ordered = pageNodes.sort((a, b) => a[1].order - b[1].order).map(([k]) => k);
  }
  return ordered.slice(0, PDF_LIMITS.maxPages).map(num =>
    nodes.get(num)!.contents.map(c => textByObj.get(c)).filter((t): t is string => !!t).join('\n'));
}

/* ----------------------------------------------------------------------------------------------- */
/* Content-stream text extraction: a single linear pass tokenizer                                    */
/* ----------------------------------------------------------------------------------------------- */

const DELIMS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);
const isSpace = (c: string) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';

export function extractTextLines(content: string): string[] {
  const lines: string[] = [];
  let lastString: string | null = null;
  let arrayParts: string[] | null = null;
  let lastArray: string[] | null = null;
  let i = 0;
  const n = content.length;

  const emit = (text: string | null) => {
    if (text === null) return;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean) lines.push(clean);
  };

  while (i < n) {
    const c = content[i];
    if (isSpace(c)) { i++; continue; }
    if (c === '%') { while (i < n && content[i] !== '\n' && content[i] !== '\r') i++; continue; }

    if (c === '(') {
      const { value, next } = readLiteralString(content, i);
      i = next;
      lastString = value;
      if (arrayParts) arrayParts.push(value);
      continue;
    }
    if (c === '<') {
      if (content[i + 1] === '<') { i += 2; continue; }
      const close = content.indexOf('>', i + 1);
      if (close < 0) break;
      const decoded = decodeHexString(content.slice(i + 1, close));
      i = close + 1;
      if (decoded !== null) {
        lastString = decoded;
        if (arrayParts) arrayParts.push(decoded);
      }
      continue;
    }
    if (c === '>') { i += content[i + 1] === '>' ? 2 : 1; continue; }
    if (c === '[') { arrayParts = []; i++; continue; }
    if (c === ']') { if (arrayParts) { lastArray = arrayParts; arrayParts = null; } i++; continue; }
    if (c === '/') { i++; while (i < n && !isSpace(content[i]) && !DELIMS.has(content[i])) i++; continue; }
    if ((c >= '0' && c <= '9') || c === '+' || c === '-' || c === '.') {
      const start = i;
      while (i < n && /[0-9+\-.]/.test(content[i])) i++;
      if (arrayParts && arrayParts.length > 0) {
        const kern = Number(content.slice(start, i));
        if (Number.isFinite(kern) && kern < -200) arrayParts.push(' ');   // large negative kerning = word gap
      }
      continue;
    }
    if (c === ')' || c === '{' || c === '}') { i++; continue; }

    // operator
    const start = i;
    while (i < n && !isSpace(content[i]) && !DELIMS.has(content[i])) i++;
    if (i === start) { i++; continue; }
    const op = content.slice(start, i);
    if (op === 'Tj' || op === "'" || op === '"') emit(lastString);
    else if (op === 'TJ' && lastArray) emit(lastArray.join(''));
    if (op !== 'BT') { lastString = null; }
    if (op === 'TJ' || op === 'Tj') lastArray = null;
  }
  return lines;
}

function readLiteralString(s: string, start: number): { value: string; next: number } {
  let i = start + 1;
  let depth = 1;
  let out = '';
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '\\') {
      const e = s[i + 1];
      if (e === undefined) { i++; break; }
      if (e >= '0' && e <= '7') {
        let j = i + 1;
        let oct = '';
        while (j < n && oct.length < 3 && s[j] >= '0' && s[j] <= '7') oct += s[j++];
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        i = j;
        continue;
      }
      if (e === '\r' || e === '\n') { i += (e === '\r' && s[i + 2] === '\n') ? 3 : 2; continue; }   // line continuation
      const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
      out += map[e] ?? e;
      i += 2;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
    if (out.length < 20_000) out += ch;          // keep scanning (linear) but stop collecting past the cap
    i++;
  }
  return { value: out, next: i };
}

function decodeHexString(hex: string): string | null {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length === 0 || clean.length > 40_000 || !/^[0-9a-fA-F]+$/.test(clean)) return null;
  const padded = clean.length % 2 ? clean + '0' : clean;
  let bytes = '';
  for (let i = 0; i < padded.length; i += 2) bytes += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16));
  // UTF-16BE ASCII-range text (00 41 00 42 ...) -> keep the low bytes
  if (bytes.length >= 2 && bytes.length % 2 === 0 && [...bytes].filter((_, k) => k % 2 === 0).every(ch => ch === '\0')) {
    bytes = [...bytes].filter((_, k) => k % 2 === 1).join('');
  }
  const printable = [...bytes].filter(ch => ch >= ' ' && ch <= '~').length;
  return printable / bytes.length >= 0.9 ? bytes : null;     // custom-encoded fonts yield codes, not text: ignore
}
