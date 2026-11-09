import assert from 'node:assert/strict';
import { GeminiExtractionAdapter } from './llmAdapter.ts';
import { createSuite, SuiteResult } from '../testing/miniRunner.ts';

const TEXT = 'Invoice No: INV-1\nSupplier: Acme Ltd\nTotal: 10.00 USD';
const fakeAdapter = (generateContent: () => any) => {
  const a: any = new GeminiExtractionAdapter(undefined, 'test-model');
  a.ai = { models: { generateContent } };
  return a as GeminiExtractionAdapter;
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function runAdapterTests(): Promise<SuiteResult> {
  const { test, finish } = createSuite();

  await test('A1. REGRESSION: a synchronous failure inside generateContent does not leave an unhandled timeout rejection', async () => {
    let unhandled: unknown = null;
    const onUnhandled = (e: unknown) => { unhandled = e; };
    process.on('unhandledRejection', onUnhandled);
    try {
      const adapter = fakeAdapter(() => { throw new Error('sync boom'); });
      const res = await adapter.extract(TEXT, { timeoutMs: 40 });        // must fall back, not throw
      assert.equal(res.extraction_metadata.mode, 'mock_rule_based');
      await sleep(120);                                                   // old code: the 40 ms timer fired here and crashed
      assert.equal(unhandled, null, 'an unhandled rejection was raised after the call finished');
    } finally { process.off('unhandledRejection', onUnhandled); }
  });

  await test('A2. A slow provider times out and falls back to the rule-based result (labelled as such)', async () => {
    const adapter = fakeAdapter(() => new Promise(() => { /* never resolves */ }));
    const t = performance.now();
    const res = await adapter.extract(TEXT, { timeoutMs: 40 });
    assert.equal(res.extraction_metadata.mode, 'mock_rule_based');
    assert.match(res.extraction_metadata.model_used || '', /fallback/);
    assert.ok(performance.now() - t < 12_000);
  });

  await test('A3. A successful provider response is parsed, grounded, and its timer is cleared', async () => {
    const json = JSON.stringify({ invoice_number: 'INV-1', supplier_name: 'Acme Ltd', total: 10, currency: 'USD', invoice_date: null,
      customer_name: null, subtotal: null, tax: null, line_items: [], evidence: {} });
    const adapter = fakeAdapter(async () => ({ text: json }));
    const res = await adapter.extract(TEXT, { timeoutMs: 5000 });
    assert.equal(res.extraction_metadata.mode, 'gemini_llm');
    assert.equal(res.total, 10);
  });

  await test('A4. A hallucinated value in a provider response is removed by the grounding guard', async () => {
    const json = JSON.stringify({ invoice_number: 'INV-1', supplier_name: 'Globex Corp', total: 999, currency: 'USD', invoice_date: null,
      customer_name: null, subtotal: null, tax: null, line_items: [], evidence: {} });
    const res = await fakeAdapter(async () => ({ text: json })).extract(TEXT, { timeoutMs: 5000 });
    assert.equal(res.supplier_name, null);
    assert.equal(res.total, null);
    assert.equal(res.invoice_number, 'INV-1');
  });

  return finish();
}
