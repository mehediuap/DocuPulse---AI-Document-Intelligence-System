import assert from 'node:assert/strict';
import { createApiKeyAuth, createRateLimiter, safeEqual } from './auth.ts';
import { safeErrorHandler } from './errorHandler.ts';
import { HttpError } from './httpError.ts';
import { toPublicDocument } from './publicDocument.ts';
import { createSuite, SuiteResult } from '../testing/miniRunner.ts';

function fakeRes() {
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined as any };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
}
function fakeReq(headers: Record<string, string> = {}, path = '/api/v1/documents', ip = '1.2.3.4') {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { path, ip, header: (n: string) => lower[n.toLowerCase()], socket: { remoteAddress: ip } } as any;
}
function run(mw: any, req: any) {
  const res = fakeRes();
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  return { res, nexted };
}

export async function runSecurityTests(): Promise<SuiteResult> {
  const { test, finish } = createSuite();

  await test('S1. API key: missing or wrong key is rejected with 401', () => {
    const mw = createApiKeyAuth({ DOCUPULSE_API_KEY: 'secret-key' } as any);
    for (const headers of [{}, { 'x-api-key': 'nope' }, { authorization: 'Bearer nope' }] as Record<string, string>[]) {
      const { res, nexted } = run(mw, fakeReq(headers));
      assert.equal(nexted, false);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.error.code, 'UNAUTHORIZED');
    }
  });

  await test('S2. API key: correct key via X-API-Key or Bearer passes', () => {
    const mw = createApiKeyAuth({ DOCUPULSE_API_KEY: 'secret-key' } as any);
    assert.equal(run(mw, fakeReq({ 'X-API-Key': 'secret-key' })).nexted, true);
    assert.equal(run(mw, fakeReq({ Authorization: 'Bearer secret-key' })).nexted, true);
  });

  await test('S3. Production without a configured key fails closed (503)', () => {
    const mw = createApiKeyAuth({ NODE_ENV: 'production' } as any);
    const { res, nexted } = run(mw, fakeReq({ 'x-api-key': 'anything' }));
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 503);
  });

  await test('S4. Development without a key stays open; /health is always public', () => {
    const warn = console.warn; console.warn = () => {};
    try {
      assert.equal(run(createApiKeyAuth({} as any), fakeReq()).nexted, true);
    } finally { console.warn = warn; }
    assert.equal(run(createApiKeyAuth({ DOCUPULSE_API_KEY: 'k' } as any), fakeReq({}, '/health')).nexted, true);
  });

  await test('S5. safeEqual is correct for equal, different and different-length values', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
  });

  await test('S6. Rate limiter blocks after max, sends Retry-After, isolates clients, resets after the window', () => {
    let t = 0;
    const mw = createRateLimiter({ windowMs: 1000, max: 3, now: () => t });
    for (let i = 0; i < 3; i++) assert.equal(run(mw, fakeReq({}, '/x', '9.9.9.9')).nexted, true);
    const blocked = run(mw, fakeReq({}, '/x', '9.9.9.9'));
    assert.equal(blocked.nexted, false);
    assert.equal(blocked.res.statusCode, 429);
    assert.ok(Number(blocked.res.headers['Retry-After']) >= 1);
    assert.equal(run(mw, fakeReq({}, '/x', '8.8.8.8')).nexted, true);   // other client unaffected
    t += 1001;
    assert.equal(run(mw, fakeReq({}, '/x', '9.9.9.9')).nexted, true);   // window reset
  });

  await test('S7. Error handler: HttpError keeps its message; unknown errors never leak details', () => {
    const logged = console.error; console.error = () => {};
    try {
      const a = fakeRes();
      safeErrorHandler(new HttpError(404, 'DOCUMENT_NOT_FOUND', 'nope', 'id'), {} as any, a, () => {});
      assert.equal(a.statusCode, 404);
      assert.equal(a.body.error.message, 'nope');

      const b = fakeRes();
      safeErrorHandler(new Error('SQLITE_ERROR: no such table documents at /srv/app/db.ts:42'), {} as any, b, () => {});
      assert.equal(b.statusCode, 500);
      assert.equal(b.body.error.code, 'INTERNAL_SERVER_ERROR');
      assert.ok(!/sqlite|srv|db\.ts/i.test(JSON.stringify(b.body)), 'internal message leaked');
    } finally { console.error = logged; }
  });

  await test('S8. Error handler maps body-parser errors (413 too large, 400 bad JSON)', () => {
    const a = fakeRes();
    safeErrorHandler({ type: 'entity.too.large' }, {} as any, a, () => {});
    assert.equal(a.statusCode, 413);
    const b = fakeRes();
    safeErrorHandler({ type: 'entity.parse.failed', message: 'Unexpected token' }, {} as any, b, () => {});
    assert.equal(b.statusCode, 400);
    assert.equal(b.body.error.code, 'INVALID_JSON');
  });

  await test('S9. toPublicDocument strips rawBuffer, rawText and storagePath; JSON stays small', () => {
    const doc: any = { id: 'doc_1', originalFilename: 'a.pdf', status: 'completed', storagePath: '/srv/data/x.bin',
      rawText: 'secret text '.repeat(1000), rawBuffer: new Uint8Array(200_000).fill(7), auditTrail: [], errors: [], warnings: [] };
    const pub: any = toPublicDocument(doc);
    assert.equal(pub.rawBuffer, undefined);
    assert.equal(pub.rawText, undefined);
    assert.equal(pub.storagePath, undefined);
    assert.equal(pub.id, 'doc_1');
    assert.ok(JSON.stringify(pub).length < 1000);
    assert.ok(JSON.stringify(doc).length > 1_000_000, 'sanity: the unsanitised record really is huge');
  });

  return finish();
}
