import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { processPdf, PDF_LIMITS, decodeAscii85 } from './pdfProcessor.ts';
import { createSuite, SuiteResult } from '../testing/miniRunner.ts';

const enc = (s: string) => new TextEncoder().encode(s);

function ascii85(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 4) {
    const chunk = data.subarray(i, i + 4);
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (chunk[k] ?? 0);
    if (chunk.length === 4 && v === 0) { out += 'z'; continue; }
    const digits: string[] = [];
    for (let k = 0; k < 5; k++) { digits.unshift(String.fromCharCode((v % 85) + 33)); v = Math.floor(v / 85); }
    out += digits.slice(0, chunk.length + 1).join('');
  }
  return out + '~>';
}

type Encoding = 'plain' | 'flate' | 'a85flate';

/** Builds a small but structurally valid PDF. `fileOrder` lets tests place page objects out of /Kids order. */
function buildPdf(pageTexts: string[], encoding: Encoding = 'plain', fileOrder?: number[]): Uint8Array {
  const n = pageTexts.length;
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const add = (s: string | Buffer) => chunks.push(typeof s === 'string' ? Buffer.from(s, 'latin1') : s);
  add('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  add(`2 0 obj\n<< /Type /Pages /Kids [${pageTexts.map((_, i) => `${3 + i} 0 R`).join(' ')}] /Count ${n} >>\nendobj\n`);
  const order = fileOrder ?? pageTexts.map((_, i) => i);
  for (const i of order) add(`${3 + i} 0 obj\n<< /Type /Page /Parent 2 0 R /Contents ${3 + n + i} 0 R >>\nendobj\n`);
  for (const i of order) {
    const content = Buffer.from(`BT /F1 12 Tf 50 700 Td (${pageTexts[i]}) Tj ET`, 'latin1');
    let body: Buffer = content;
    let filter = '';
    if (encoding === 'flate') { body = zlib.deflateSync(content); filter = '/Filter /FlateDecode '; }
    if (encoding === 'a85flate') { body = Buffer.from(ascii85(zlib.deflateSync(content)), 'latin1'); filter = '/Filter [/ASCII85Decode /FlateDecode] '; }
    add(`${3 + n + i} 0 obj\n<< ${filter}/Length ${body.length} >>\nstream\n`);
    add(body);
    add('\nendstream\nendobj\n');
  }
  add(`xref\n0 1\ntrailer\n<< /Root 1 0 R /Size ${3 + 2 * n} >>\nstartxref\n0\n%%EOF\n`);
  return new Uint8Array(Buffer.concat(chunks));
}

function rawPdf(body: string): Uint8Array {
  return enc(`%PDF-1.4\n${body}\nxref\n0 1\ntrailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`);
}

export async function runPdfProcessorTests(): Promise<SuiteResult> {
  const { test, finish } = createSuite();

  await test('P1. Plain (uncompressed) PDF text is extracted', async () => {
    const r = await processPdf(buildPdf(['Invoice: INV-1 Total: 10.00 USD']), 'a.pdf');
    assert.equal(r.metadata.isScanned, false);
    assert.match(r.rawText, /Invoice: INV-1 Total: 10\.00 USD/);
  });

  await test('P2. FlateDecode PDF (what most generators emit) is extracted, not misclassified as scanned', async () => {
    const r = await processPdf(buildPdf(['Invoice: INV-2 Total: 20.00 USD'], 'flate'), 'b.pdf');
    assert.equal(r.metadata.isScanned, false);
    assert.match(r.rawText, /INV-2/);
  });

  await test('P3. ASCII85 + Flate filter chain (reportlab style) is extracted', async () => {
    const r = await processPdf(buildPdf(['Supplier: Acme Ltd Total: 30.00'], 'a85flate'), 'c.pdf');
    assert.equal(r.metadata.isScanned, false);
    assert.match(r.rawText, /Acme Ltd/);
  });

  await test('P4. ASCII85 decoder round-trips arbitrary bytes, including zero groups', () => {
    const data = new Uint8Array([0, 0, 0, 0, 1, 2, 3, 4, 5, 255, 254, 0, 0, 0, 0, 9, 9]);
    assert.deepEqual([...decodeAscii85(Buffer.from(ascii85(data), 'latin1'), 1024)], [...data]);
  });

  await test('P5. Page attribution follows the /Kids order, not file order', async () => {
    const r = await processPdf(buildPdf(['FIRST-PAGE', 'SECOND-PAGE', 'THIRD-PAGE'], 'flate', [2, 0, 1]), 'd.pdf');
    assert.equal(r.pages.length, 3);
    assert.match(r.pages[0].text, /FIRST-PAGE/);
    assert.match(r.pages[1].text, /SECOND-PAGE/);
    assert.match(r.pages[2].text, /THIRD-PAGE/);
    assert.ok(!r.warnings.some(w => /approximately/.test(w)));
  });

  await test('P6. Escaped parentheses, octal escapes, TJ arrays with kerning and hex strings', async () => {
    const stream = 'BT (Acme \\(Supplies\\) Ltd) Tj ET\nBT [(Tot) -20 (al) -400 (137.50)] TJ ET\nBT (Caf\\351 \\101) Tj ET\nBT <496e766f696365> Tj ET';
    const r = await processPdf(rawPdf(`3 0 obj\n<< /Type /Page /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`), 'e.pdf');
    assert.match(r.rawText, /Acme \(Supplies\) Ltd/);
    assert.match(r.rawText, /Total 137\.50/);
    assert.match(r.rawText, /Caf\u00e9 A/);
    assert.match(r.rawText, /Invoice/);
  });

  await test('P7. Repo-style multi-page digital PDF (3 pages) keeps one page per page', async () => {
    const r = await processPdf(buildPdf(['Invoice: INV-9 Page 1', 'Invoice: INV-9 Page 2', 'Invoice: INV-9 Page 3']), 'f.pdf');
    assert.deepEqual(r.pages.map(p => p.pageNumber), [1, 2, 3]);
    assert.equal(r.metadata.hasMultiPages, true);
  });

  await test('P8. PDF with no text operators is classified as scanned and routed to OCR', async () => {
    const r = await processPdf(rawPdf('3 0 obj\n<< /Type /Page /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 12 >>\nstream\nq 0 0 cm Q\nendstream\nendobj'), 'g.pdf');
    assert.equal(r.metadata.isScanned, true);
    assert.equal(r.pages[0].isOcr, true);
  });

  await test('P9. REGRESSION: crafted "stream\\n" flood (was quadratic: 3.6 s at 200 KB) finishes quickly at 2 MB', async () => {
    const body = 'stream\nx'.repeat(Math.floor((2 * 1024 * 1024) / 8));
    const t = performance.now();
    await processPdf(rawPdf(body), 'dos.pdf').catch(() => undefined);
    const ms = performance.now() - t;
    assert.ok(ms < 3000, `took ${Math.round(ms)} ms`);
  });

  await test('P10. REGRESSION: many "(" / "[" without closers does not blow up (no quadratic regexes)', async () => {
    const stream = '(' .repeat(300_000) + ' Tj ' + '['.repeat(300_000) + ' TJ';
    const t = performance.now();
    await processPdf(rawPdf(`3 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`), 'dos2.pdf').catch(() => undefined);
    assert.ok(performance.now() - t < 3000);
  });

  await test('P11. Decompression bomb (64 MB of zeros in ~64 KB) is rejected by the size cap, not inflated', async () => {
    const bomb = zlib.deflateSync(Buffer.alloc(64 * 1024 * 1024));
    const head = Buffer.from(`3 0 obj\n<< /Filter /FlateDecode /Length ${bomb.length} >>\nstream\n`, 'latin1');
    const tail = Buffer.from('\nendstream\nendobj', 'latin1');
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), head, bomb, tail, Buffer.from('\nxref\n0 1\ntrailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF\n')]);
    const before = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
    const r = await processPdf(new Uint8Array(pdf), 'bomb.pdf');
    const grew = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers - before;
    assert.ok(r.warnings.some(w => /skipped/.test(w)), 'expected a skipped-stream warning');
    assert.ok(grew < PDF_LIMITS.maxInflatedPerStream * 4 + 32 * 1024 * 1024, `memory grew by ${Math.round(grew / 1e6)} MB`);
  });

  await test('P12. Truncated stream (no endstream) does not throw and is reported', async () => {
    const r = await processPdf(rawPdf('3 0 obj\n<< /Length 99 >>\nstream\nBT (cut off'), 'h.pdf');
    assert.ok(r.warnings.some(w => /Truncated/.test(w)));
  });

  await test('P13. Absurd /Count cannot create an unbounded number of pages', async () => {
    const stream = 'BT (hello world) Tj ET';
    const r = await processPdf(rawPdf(`2 0 obj\n<< /Type /Pages /Count 999999999 >>\nendobj\n4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`), 'i.pdf');
    assert.ok(r.pages.length <= PDF_LIMITS.maxPages);
  });

  await test('P14. Original integrity errors are preserved (header, EOF, xref/trailer)', async () => {
    await assert.rejects(() => processPdf(enc('hello world not a pdf at all'), 'x.pdf'), /%PDF- header/);
    await assert.rejects(() => processPdf(enc('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n'), 'x.pdf'), /end-of-file marker/);
    await assert.rejects(() => processPdf(enc('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF'), 'x.pdf'), /cross-reference or trailer/);
  });

  return finish();
}
