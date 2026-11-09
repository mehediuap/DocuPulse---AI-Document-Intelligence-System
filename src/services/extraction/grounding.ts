/**
 * Grounding guard: model output is NEVER trusted on its own.
 * Every extracted value must be locatable in the source text; anything that is not is set to null,
 * its evidence is cleared, and a warning is recorded. This enforces "do not invent values" in code,
 * instead of relying only on the prompt.
 */
import type { InvoiceExtractionResult, LineItemExtraction } from './schemas.ts';

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const compact = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** All numbers that appear in the text, under both decimal conventions where ambiguous. */
export function numbersIn(text: string): number[] {
  const out = new Set<number>();
  for (const tok of text.match(/\d[\d.,]*\d|\d/g) ?? []) {
    const add = (v: number) => { if (Number.isFinite(v)) out.add(Math.round(v * 1000) / 1000); };
    const lastComma = tok.lastIndexOf(','), lastDot = tok.lastIndexOf('.');
    if (lastComma >= 0 && lastDot >= 0) {
      add(Number(lastComma > lastDot ? tok.replace(/\./g, '').replace(',', '.') : tok.replace(/,/g, '')));
    } else if (lastComma >= 0) {
      add(Number(tok.replace(/,/g, '')));                                  // 1,234  -> 1234
      if (tok.split(',').length === 2) add(Number(tok.replace(',', '.')));  // 12,50  -> 12.5
    } else if ((tok.match(/\./g) ?? []).length > 1) {
      add(Number(tok.replace(/\./g, '')));                                  // 1.234.567
    } else {
      add(Number(tok));
    }
  }
  return [...out];
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function dateForms(iso: string): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return [norm(iso)];
  const [, y, mo, d] = m;
  const mi = Number(mo) - 1, di = Number(d);
  const name = MONTHS[mi];
  const forms = [`${y} ${mo} ${d}`, `${d} ${mo} ${y}`, `${mo} ${d} ${y}`, `${di} ${Number(mo)} ${y}`, `${Number(mo)} ${di} ${y}`,
    `${name} ${di} ${y}`, `${di} ${name} ${y}`, `${name.slice(0, 3)} ${di} ${y}`, `${di} ${name.slice(0, 3)} ${y}`,
    `${name} ${d} ${y}`, `${d} ${name} ${y}`];
  return forms.map(norm);
}

const SYMBOL_TO_CODE: Record<string, string> = { '€': 'EUR', '£': 'GBP', '₹': 'INR', '৳': 'BDT' };

export interface GroundingReport { ungrounded: string[]; weakEvidence: string[] }

export function groundExtraction(result: InvoiceExtractionResult, sourceText: string): { result: InvoiceExtractionResult; report: GroundingReport } {
  const source = norm(sourceText);
  const sourceCompact = compact(sourceText);
  const sourceTokens = new Set(source.split(' '));
  const nums = numbersIn(sourceText);
  const hasNumber = (v: number) => nums.some(n => Math.abs(n - Math.abs(v)) < 0.0051 || Math.abs(n - v) < 0.0051);
  const tokenOverlap = (value: string, min: number) => {
    const toks = norm(value).split(' ').filter(Boolean);
    return toks.length > 0 && toks.filter(t => sourceTokens.has(t)).length / toks.length >= min;
  };

  const out: InvoiceExtractionResult = JSON.parse(JSON.stringify(result));
  const report: GroundingReport = { ungrounded: [], weakEvidence: [] };
  const warnings = out.extraction_metadata.warnings;

  const drop = (field: string, value: unknown, reason = 'not found in the document text') => {
    (out as any)[field] = null;
    out.evidence[field] = { snippet: null, page_reference: null, confidence: 0 };
    report.ungrounded.push(field);
    warnings.push(`Ungrounded value removed: ${field} = ${JSON.stringify(value)} (${reason}).`);
  };

  for (const f of ['subtotal', 'tax', 'total'] as const) {
    const v = out[f];
    if (v !== null && !hasNumber(v)) drop(f, v);
  }
  if (out.invoice_number !== null && !sourceCompact.includes(compact(out.invoice_number))) drop('invoice_number', out.invoice_number);
  for (const f of ['supplier_name', 'customer_name'] as const) {
    const v = out[f];
    if (v !== null && !(source.includes(norm(v)) || tokenOverlap(v, 0.8))) drop(f, v);
  }
  if (out.invoice_date !== null) {
    const found = dateForms(out.invoice_date).some(form => source.includes(form));
    if (!found) drop('invoice_date', out.invoice_date);
  }
  if (out.currency !== null) {
    const code = out.currency.toUpperCase();
    const printedCode = new RegExp(`(^|[^A-Za-z])${code}([^A-Za-z]|$)`).test(sourceText.toUpperCase());
    const printedSymbol = Object.entries(SYMBOL_TO_CODE).some(([sym, c]) => c === code && sourceText.includes(sym));
    if (!printedCode && !printedSymbol) {
      drop('currency', out.currency, 'code not printed in the document; a bare "$" or "¥" is ambiguous');
    }
  }

  const keep: LineItemExtraction[] = [];
  out.line_items.forEach((item, idx) => {
    const li: LineItemExtraction = { ...item };
    if (li.description && !(source.includes(norm(li.description)) || tokenOverlap(li.description, 0.6))) {
      warnings.push(`Ungrounded value removed: line_items[${idx}].description = ${JSON.stringify(li.description)}.`);
      report.ungrounded.push(`line_items[${idx}].description`);
      li.description = null;
    }
    for (const k of ['quantity', 'unit_price', 'amount'] as const) {
      const v = li[k];
      if (v !== null && !hasNumber(v)) {
        warnings.push(`Ungrounded value removed: line_items[${idx}].${k} = ${v}.`);
        report.ungrounded.push(`line_items[${idx}].${k}`);
        li[k] = null;
      }
    }
    if (li.description !== null || li.quantity !== null || li.unit_price !== null || li.amount !== null) keep.push(li);
  });
  out.line_items = keep;

  // Evidence snippets that cannot be found verbatim are suspicious even when the value itself was found.
  for (const [field, ev] of Object.entries(out.evidence)) {
    if (ev?.snippet && !source.includes(norm(ev.snippet)) && !sourceCompact.includes(compact(ev.snippet))) {
      report.weakEvidence.push(field);
      ev.confidence = Math.min(ev.confidence, 0.3);
      ev.snippet = null;
      warnings.push(`Evidence snippet for ${field} could not be found in the document and was discarded.`);
    }
  }
  return { result: out, report };
}
