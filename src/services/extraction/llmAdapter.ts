/**
 * Configurable LLM & Deterministic Extraction Adapters
 * Supports Gemini 3.8 Flash and deterministic offline mock/rule-based mode.
 */

import type { GoogleGenAI } from '@google/genai';
import {
  InvoiceExtractionResult,
  LineItemExtraction,
  validateInvoiceExtraction,
  createEmptyExtractionResult,
} from './schemas.ts';
import { groundExtraction } from './grounding.ts';
import {
  INVOICE_EXTRACTION_SYSTEM_INSTRUCTION,
  buildInvoiceExtractionPrompt,
} from './prompts.ts';
import {
  createGoogleGenAIClient,
  getGoogleGenAIRuntimeEnvironment,
  resolveGoogleGenAIOptions,
} from './googleGenAIConfig.ts';

export interface ExtractionOptions {
  timeoutMs?: number;
  mockMode?: boolean;
  modelOverride?: string;
}

export interface ExtractionAdapter {
  extract(documentText: string, options?: ExtractionOptions): Promise<InvoiceExtractionResult>;
}

type ParsedField = { value: string; snippet: string };
type ParsedAmountField = { value: number; snippet: string };

const FIELD_LABELS = {
  invoice_number: ['rechnungsnummer', 'rechnung nr', 'invoice number', 'invoice no.', 'invoice no', 'invoice num', 'invoice #', 'invoice id', 'invoice ref', 'bill number', 'bill no.', 'bill no', 'bill #'],
  invoice_date: ['rechnungsdatum', 'datum', 'invoice date', 'issue date', 'date issued', 'dated', 'date'],
  supplier_name: ['lieferant', 'supplier', 'vendor', 'seller', 'issuer', 'from', 'billed by', 'remit from'],
  customer_name: ['kunde', 'customer', 'client', 'buyer', 'billed to', 'bill to', 'invoice to', 'sold to', 'remit to', 'attn'],
  subtotal: ['zwischensumme', 'sub total', 'subtotal', 'net amount'],
  tax: ['mehrwertsteuer', 'mwst', 'sales tax', 'tax amount', 'tax', 'vat', 'gst'],
  total: ['gesamtbetrag', 'total balance due', 'balance due', 'amount due', 'grand total', 'invoice total', 'total due', 'total amount', 'total'],
  currency: ['waehrung', 'currency', 'currency code'],
} as const;

const INVOICE_NUMBER_PATTERN = /\bINV-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/i;
const DATE_VALUE_PATTERN = /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}([-/.])\d{1,2}\1\d{2,4}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\.?,?\s+\d{4}|[A-Za-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})\b/;
const CURRENCY_CODES = new Set([
  'USD', 'CAD', 'AUD', 'NZD', 'EUR', 'GBP', 'JPY', 'CNY', 'INR', 'CHF', 'SGD', 'HKD',
  'BDT', 'PKR', 'LKR', 'NPR', 'AED', 'SAR', 'QAR', 'KWD', 'MYR', 'THB', 'IDR', 'PHP', 'VND', 'KRW', 'TWD',
  'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'TRY', 'RUB', 'ILS', 'EGP', 'ZAR', 'NGN', 'KES', 'BRL', 'MXN', 'ARS', 'CLP',
]);
const CODE_ALT = [...CURRENCY_CODES].join('|');
const CODE_PREFIX_RE = new RegExp(`^(?:${CODE_ALT})\\s*`, 'i');
const CODE_SUFFIX_RE = new RegExp(`\\s*(?:${CODE_ALT})$`, 'i');
const CODE_THEN_SIGN_RE = new RegExp(`^(?:${CODE_ALT})\\s+([-+])\\s*`, 'i');
const AMOUNT_TOKEN_RE = new RegExp(`^\\s*(?:\\(\\s*)?[+-]?\\s*(?:(?:${CODE_ALT})\\s+)?[$€£¥₹৳]?\\s*\\d[\\d.,' OIl|]*(?:\\s*\\))?(?:\\s*(?:${CODE_ALT}))?`, 'i');
const CODE_WORD_RE = new RegExp(`\\b(?:${CODE_ALT})\\b`);

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

function isoDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Normalises a printed date to YYYY-MM-DD. Day-first vs month-first ambiguity is never guessed: returns 'ambiguous'. */
export function normalizeDateToIso(raw: string): string | 'ambiguous' | null {
  let s = raw.trim().replace(/\s+/g, ' ');
  if (/^[0-9OIl|][0-9OIl|./-]*$/i.test(s)) {
    s = s.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
  }
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})([-/.])(\d{1,2})\2(\d{2,4})$/);
  if (m) {
    const a = +m[1], b = +m[3];
    const y = m[4].length === 2 ? 2000 + +m[4] : +m[4];
    if (m[2] === '.') return isoDate(y, b, a);              // dd.mm.yyyy is day-first
    if (a > 12) return isoDate(y, b, a);
    if (b > 12) return isoDate(y, a, b);
    if (a === b) return isoDate(y, a, b);
    return 'ambiguous';
  }
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return isoDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) return isoDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  return null;
}

function normalizeForMatching(value: string): string {
  return value
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/[：]/g, ':')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function normalizeLabel(value: string): string {
  return normalizeForMatching(value)
    .toLowerCase()
    .replace(/^row\s*\d+\s*:\s*/, '')
    .replace(/[.:#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getValueAfterLabel(line: string, labels: readonly string[]): string | null {
  const sortedLabels = [...labels].sort((a, b) => b.length - a.length);
  const labelPattern = sortedLabels
    .map(label => escapeRegExp(normalizeForMatching(label)).replace(/ /g, '\\s+'))
    .join('|');
  const match = line.match(new RegExp(
    `^\\s*(?:Row\\s*\\d+\\s*:\\s*)?(?:${labelPattern})(?:\\s*[:#|'"\u2018\u2019\u201c\u201d\\-]\\s*|\\s+)(.*?)\\s*$`,
    'i'
  ));
  return match?.[1]?.trim().replace(/^["']|["']$/g, '') || null;
}

function findLabeledField(lines: string[], labels: readonly string[]): ParsedField | null {
  const allLabels = Object.values(FIELD_LABELS).flat().sort((a, b) => b.length - a.length);
  const allLabelsPattern = allLabels
    .map(label => escapeRegExp(normalizeForMatching(label)).replace(/ /g, '\\s+'))
    .join('|');
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const normalized = normalizeForMatching(raw).replace(/^[^\p{L}\p{N}]*/u, '');
    if (!normalized || normalized.startsWith('---')) continue;
    let value = getValueAfterLabel(normalized, labels);
    let snippet = raw;

    if (!value) {
      const fieldPattern = [...labels].sort((a, b) => b.length - a.length)
        .map(label => escapeRegExp(normalizeForMatching(label)).replace(/ /g, '\\s+'))
        .join('|');
      const embedded = normalized.match(new RegExp(
        `(?:^|[|]\\s*|\\s+)(?:${fieldPattern})\\s*[:#|]\\s*(.*?)(?=\\s+(?:${allLabelsPattern})\\s*[:#|]|$)`,
        'i'
      ));
      if (embedded?.[1]?.trim()) value = embedded[1].trim();
    }

    if (!value) {
      const stripped = normalized.replace(/^Row\s*\d+\s*:\s*/, '');
      if (!labels.some(label => normalizeLabel(stripped) === normalizeLabel(label))) continue;
      const next = lines.slice(index + 1).find(line => line.trim() && !line.trim().startsWith('---'));
      if (!next || Object.values(FIELD_LABELS).some(known => getValueAfterLabel(normalizeForMatching(next), known))) continue;
      value = normalizeForMatching(next);
      snippet = `${raw}\n${next}`;
    }

    if (value) return { value, snippet };
  }
  return null;
}

function findTableField(lines: string[], labels: readonly string[]): ParsedField | null {
  const normalizedLabels = new Set(labels.map(normalizeLabel));
  for (let index = 0; index < lines.length - 1; index++) {
    const headerLine = normalizeForMatching(lines[index]);
    if (/^Row\s*\d+\s*:/i.test(headerLine)) continue;
    const headers = headerLine.split('|').map(normalizeLabel);
    const column = headers.findIndex(header => normalizedLabels.has(header));
    if (column < 0) continue;

    const rowIndex = lines.slice(index + 1).findIndex(line => /^\s*Row\s*\d+\s*:/i.test(line));
    if (rowIndex < 0) continue;
    const sourceRow = lines[index + 1 + rowIndex];
    const cells = normalizeForMatching(sourceRow).replace(/^\s*Row\s*\d+\s*:\s*/i, '').split('|');
    const value = cells[column]?.trim().replace(/^["']|["']$/g, '');
    if (value) return { value, snippet: sourceRow };
  }
  return null;
}

function parseLocalizedAmount(raw: string): number | null {
  let value = normalizeForMatching(raw).replace(/[\u2212]/g, '-');
  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1).trim();
  }
  const currencyThenSign = value.match(/^[$€£¥₹৳]\s*([-+])\s*/);
  if (currencyThenSign) {
    negative = currencyThenSign[1] === '-' ? !negative : negative;
    value = value.slice(currencyThenSign[0].length);
  }
  const codeThenSign = value.match(CODE_THEN_SIGN_RE);
  if (codeThenSign) {
    negative = codeThenSign[1] === '-' ? !negative : negative;
    value = value.slice(codeThenSign[0].length);
  }
  if (value.startsWith('-')) {
    negative = !negative;
    value = value.slice(1).trim();
  } else if (value.startsWith('+')) {
    value = value.slice(1).trim();
  }

  value = value
    .replace(CODE_PREFIX_RE, '')
    .replace(CODE_SUFFIX_RE, '')
    .replace(/[$€£¥₹৳]/g, '')
    .trim()
    .replace(/[Oo]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/(?<=[\d.,])\s+(?=[\d.,])/g, '')
    .replace(/(?<=\d)[ '\u2019](?=\d)/g, '');
  if (!/^\d[\d.,]*$/.test(value) && !/^\.\d+$/.test(value)) return null;

  const lastComma = value.lastIndexOf(',');
  const lastDot = value.lastIndexOf('.');
  let decimalSeparator: ',' | '.' | null = null;
  const isValidGrouping = (integer: string, separator: string): boolean => {
    const groups = integer.split(separator);
    if (groups.length === 1) return /^\d+$/.test(integer);
    const westernGrouping = groups[0].length >= 1 && groups[0].length <= 3 &&
      groups.slice(1).every(group => group.length === 3);
    const indianGrouping = groups.length >= 3 && groups[0].length >= 1 && groups[0].length <= 2 &&
      groups.slice(1, -1).every(group => group.length === 2) && groups[groups.length - 1].length === 3;
    return (westernGrouping || indianGrouping) && groups.every(group => /^\d+$/.test(group));
  };
  if (lastComma >= 0 && lastDot >= 0) {
    decimalSeparator = lastComma > lastDot ? ',' : '.';
    const integerPart = value.slice(0, Math.max(lastComma, lastDot));
    const groupingSeparator = decimalSeparator === ',' ? '.' : ',';
    if (!isValidGrouping(integerPart, groupingSeparator)) return null;
    if (value.length - Math.max(lastComma, lastDot) - 1 > 2) return null;
  } else {
    const separator = lastComma >= 0 ? ',' : lastDot >= 0 ? '.' : null;
    if (separator) {
      const occurrences = value.split(separator).length - 1;
      const trailingDigits = value.length - value.lastIndexOf(separator) - 1;
      if (occurrences === 1 && trailingDigits > 0 && trailingDigits <= 2) {
        decimalSeparator = separator;
      } else if (occurrences === 1 && trailingDigits === 3) {
        if (!isValidGrouping(value, separator)) return null;
        decimalSeparator = null;
      } else if (occurrences > 1) {
        const groups = value.split(separator);
        if (groups.slice(1).some(group => group.length !== 3)) {
          const lastGroup = groups.pop()!;
          if (lastGroup.length <= 2 && isValidGrouping(groups.join(separator), separator)) decimalSeparator = separator;
          else return null;
        } else if (!isValidGrouping(value, separator)) {
          return null;
        }
      } else if (trailingDigits > 2) {
        return null;
      }
      if (decimalSeparator && !isValidGrouping(value.slice(0, value.lastIndexOf(separator)), separator)) return null;
    }
  }

  let normalized: string;
  if (decimalSeparator) {
    const groupingSeparator = decimalSeparator === ',' ? '.' : ',';
    const decimalIndex = value.lastIndexOf(decimalSeparator);
    const integerPart = value.slice(0, decimalIndex).replace(new RegExp(`\\${groupingSeparator}`, 'g'), '');
    const fractionPart = value.slice(decimalIndex + 1);
    if (!/^\d*$/.test(integerPart) || !/^\d{1,2}$/.test(fractionPart)) return null;
    normalized = `${integerPart || '0'}.${fractionPart}`;
  } else {
    normalized = value.replace(/[.,]/g, '');
  }
  const amount = Number(normalized) * (negative ? -1 : 1);
  return Number.isFinite(amount) ? amount : null;
}

function parseLabeledAmount(value: string, field: 'subtotal' | 'tax' | 'total'): number | null {
  let amountText = field === 'tax'
    ? value.replace(/^\s*(?:\d+(?:[.,]\d+)?\s*%|\([^)]*%\))\s*[:|-]?\s*/, '')
    : value;
  const amountToken = amountText.match(AMOUNT_TOKEN_RE);
  if (!amountToken) return null;
  amountText = amountToken[0].trim();
  return parseLocalizedAmount(amountText);
}

function findCurrency(lines: string[], labeledCurrency: ParsedField | null): ParsedField | null {
  if (labeledCurrency) {
    const code = labeledCurrency.value.trim().toUpperCase();
    if (CURRENCY_CODES.has(code)) return { value: code, snippet: labeledCurrency.snippet };
    if (code === '€') return { value: 'EUR', snippet: labeledCurrency.snippet };
    if (code === '£') return { value: 'GBP', snippet: labeledCurrency.snippet };
    if (code === '₹') return { value: 'INR', snippet: labeledCurrency.snippet };
    if (code === '৳') return { value: 'BDT', snippet: labeledCurrency.snippet };
  }

  for (const raw of lines) {
    const normalized = normalizeForMatching(raw).toUpperCase();
    const code = normalized.match(CODE_WORD_RE)?.[0];
    if (code) return { value: code, snippet: raw };
    if (normalized.includes('€')) return { value: 'EUR', snippet: raw };
    if (normalized.includes('£')) return { value: 'GBP', snippet: raw };
    if (normalized.includes('₹')) return { value: 'INR', snippet: raw };
    if (normalized.includes('৳')) return { value: 'BDT', snippet: raw };
  }
  for (const raw of lines) {
    const normalized = normalizeForMatching(raw).toUpperCase();
    if (!/\b(?:TOTAL|BALANCE DUE|AMOUNT DUE|GRAND TOTAL)\b/.test(normalized)) continue;
    const trailingToken = normalized.match(/\b([A-Z0-9]{3})\s*$/)?.[1];
    if (!trailingToken) continue;
    const closeCodes = [...CURRENCY_CODES].filter(code => hasSingleCharacterDifference(code, trailingToken));
    if (closeCodes.length === 1) return { value: closeCodes[0], snippet: raw };
  }
  return null;
}

function hasSingleCharacterDifference(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let differences = 0;
  for (let index = 0; index < expected.length; index++) {
    if (expected[index] !== actual[index] && ++differences > 1) return false;
  }
  return differences === 1;
}

/**
 * Deterministic, offline, rule-based extractor.
 * Operates hermetically without any external network or paid API key.
 * Always returns null for missing fields and labels its mode clearly.
 */
export class MockRuleBasedAdapter implements ExtractionAdapter {
  public async extract(
    documentText: string,
    _options: ExtractionOptions = {}
  ): Promise<InvoiceExtractionResult> {
    const startTime = performance.now();
    logSafe(`Executing MockRuleBasedAdapter on document (${documentText.length} chars)`);

    const warnings: string[] = [];
    const evidence: Record<string, { snippet: string; page_reference: number; confidence: number }> = {};

    // Determine page reference if marked
    const pageMatch = documentText.match(/---\s*PAGE\s*(\d+)\s*---/i);
    const defaultPage = pageMatch ? parseInt(pageMatch[1], 10) : 1;

    const docLines = documentText.split(/\r?\n/);
    const hasOcrUnavailableNotice = docLines.some(line =>
      normalizeForMatching(line).toUpperCase() === '[OCR TEXT UNAVAILABLE]'
    );
    const cleanLines = docLines.filter(line => {
      const normalized = normalizeForMatching(line);
      if (normalized.startsWith('--- CSV DATA:') || normalized.startsWith('--- WORKSHEET:')) return false;
      return !hasOcrUnavailableNotice ||
        !/^(?:File:|Detected Format:|No text was inferred\b)/i.test(normalized);
    });

    let invoice_number: string | null = null;
    let invoice_date: string | null = null;
    let supplier_name: string | null = null;
    let customer_name: string | null = null;
    let subtotal: number | null = null;
    let tax: number | null = null;
    let total: number | null = null;
    let currency: string | null = null;

    const addEvidence = (field: string, parsed: ParsedField | ParsedAmountField, confidence: number) => {
      evidence[field] = { snippet: parsed.snippet, page_reference: defaultPage, confidence };
    };
    const findField = (labels: readonly string[]) =>
      findTableField(docLines, labels) || findLabeledField(cleanLines, labels);

    // A bare title such as "INVOICE" / "TAX INVOICE" is not a label with a value on the next line.
    const numberLines = cleanLines.filter(line =>
      !/^\s*(?:tax\s+|sales\s+)?(?:invoice|bill|receipt|rechnung)\s*$/i.test(normalizeForMatching(line)));
    const invoiceNumberField = findTableField(docLines, FIELD_LABELS.invoice_number) ||
      findLabeledField(numberLines, FIELD_LABELS.invoice_number);
    if (invoiceNumberField) {
      const candidate = invoiceNumberField.value.split(/\s+/)[0].replace(/[,:;]+$/, '');
      const valueIsAnotherLabeledField = Object.values(FIELD_LABELS)
        .some(labels => getValueAfterLabel(normalizeForMatching(invoiceNumberField.value), labels));
      if (!valueIsAnotherLabeledField && candidate.toLowerCase() !== 'invoice' && /\d/.test(candidate) &&
        /^[A-Za-z0-9][A-Za-z0-9./_-]*$/.test(candidate) &&
        !Object.values(FIELD_LABELS).some(labels => labels.some(label => normalizeLabel(candidate) === normalizeLabel(label)))) {
        invoice_number = candidate;
        addEvidence('invoice_number', invoiceNumberField, 0.96);
      }
    }
    if (!invoice_number) {
      for (const line of cleanLines) {
        const normalized = normalizeForMatching(line);
        if (/^(?:invoice\s+date|date|issue\s+date)\b/i.test(normalized)) continue;
        const match = normalized.match(INVOICE_NUMBER_PATTERN);
        if (match) {
          invoice_number = match[0];
          addEvidence('invoice_number', { value: match[0], snippet: line }, 0.92);
          break;
        }
      }
    }

    const dateField = findField(FIELD_LABELS.invoice_date);
    const dateMatch = dateField?.value.match(DATE_VALUE_PATTERN) ||
      dateField?.value.match(/\b[0-9OIl|]{4}[-/.][0-9OIl|]{1,2}[-/.][0-9OIl|]{1,2}\b/i);
    if (dateField && dateMatch) {
      const iso = normalizeDateToIso(dateMatch[0]);
      if (iso === 'ambiguous') {
        warnings.push(`Ambiguous date "${dateMatch[0]}" (day-first or month-first) was not guessed; invoice_date left empty.`);
      } else {
        invoice_date = iso ?? dateMatch[0];
        addEvidence('invoice_date', dateField, 0.92);
      }
    }

    const supplierField = findField(FIELD_LABELS.supplier_name);
    if (supplierField && supplierField.value) {
      supplier_name = supplierField.value;
      addEvidence('supplier_name', supplierField, 0.88);
    } else {
      const firstContentLine = cleanLines.find(line => {
        const normalized = normalizeForMatching(line);
        return normalized && !normalized.startsWith('---') &&
          !Object.values(FIELD_LABELS).some(labels => getValueAfterLabel(normalized, labels));
      });
      if (firstContentLine && /[A-Z]/.test(firstContentLine) &&
        /\b(?:Ltd|Limited|Inc|LLC|Corp|Corporation|GmbH|Company|Co\.|Technologies|Logistics|Solutions)\b/i.test(firstContentLine)) {
        supplier_name = normalizeForMatching(firstContentLine);
        addEvidence('supplier_name', { value: supplier_name, snippet: firstContentLine }, 0.78);
      }
    }

    const customerField = findField(FIELD_LABELS.customer_name);
    if (customerField && customerField.value) {
      customer_name = customerField.value;
      addEvidence('customer_name', customerField, 0.88);
    }

    for (const [field, labels] of [
      ['subtotal', FIELD_LABELS.subtotal],
      ['tax', FIELD_LABELS.tax],
      ['total', FIELD_LABELS.total],
    ] as const) {
      const parsed = findField(labels);
      const amount = parsed ? parseLabeledAmount(parsed.value, field) : null;
      if (parsed && amount !== null) {
        if (field === 'subtotal') subtotal = amount;
        else if (field === 'tax') tax = amount;
        else total = amount;
        addEvidence(field, parsed, 0.92);
      }
    }

    const currencyField = findField(FIELD_LABELS.currency);
    const currencyResult = findCurrency(cleanLines, currencyField);
    if (currencyResult) {
      currency = currencyResult.value;
      addEvidence('currency', currencyResult, 0.95);
    }

    // 7. Line Items
    const line_items: LineItemExtraction[] = this.extractTabularLineItems(documentText, defaultPage);

    // Track missing required fields
    if (!invoice_number) warnings.push('invoice_number was not found in document text (null).');
    if (!invoice_date) warnings.push('invoice_date was not found in document text (null).');
    if (!supplier_name) warnings.push('supplier_name was not found in document text (null).');
    if (!customer_name) warnings.push('customer_name was not found in document text (null).');
    if (total === null) warnings.push('total amount was not found in document text (null).');
    if (line_items.length === 0) warnings.push('No itemized line items found in document structure.');

    const duration = Math.round(performance.now() - startTime);

    const rawPayload = {
      invoice_number,
      invoice_date,
      supplier_name,
      customer_name,
      subtotal,
      tax,
      total,
      currency,
      line_items,
      evidence,
      extraction_metadata: {
        mode: 'mock_rule_based',
        model_used: 'deterministic_rule_parser',
        processing_time_ms: duration,
        warnings,
      },
    };

    const validation = validateInvoiceExtraction(rawPayload, 'mock_rule_based');
    return validation.data;
  }

  private extractTabularLineItems(text: string, defaultPage: number): LineItemExtraction[] {
    const items: LineItemExtraction[] = [];
    const lines = text.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('---') || trimmed.toLowerCase().includes('subtotal') || trimmed.toLowerCase().includes('total:')) {
        continue;
      }

      // Check pipe-delimited format: Description | Qty | Unit Price | Amount
      if (trimmed.includes('|')) {
        const parts = trimmed.split('|').map(p => p.trim());
        if (parts.length >= 3) {
          // Check if last element is a numeric price
          const amount = parseLocalizedAmount(parts[parts.length - 1]);
          if (amount !== null) {
            const desc = parts[0].replace(/^Row\s*\d+:\s*/, '').trim();
            let qty: number | null = null;
            let unitPrice: number | null = null;

            if (parts.length >= 4) {
              const quantity = parseLocalizedAmount(parts[1]);
              if (quantity !== null) qty = quantity;
              unitPrice = parseLocalizedAmount(parts[2]);
            }

            items.push({
              description: desc,
              quantity: qty,
              unit_price: unitPrice,
              amount,
              evidence: trimmed,
              page_reference: defaultPage,
            });
          }
        }
      } else {
        // Space-delimited format: "Description Words 2 250.00 500.00"
        const spaceMatch = trimmed.match(/^([A-Za-z0-9\s.,\-_]{4,50}?)\s+([0-9]+(?:[.,][0-9]+)?)\s+([+$€£¥₹()0-9.,\s-]+)\s+([+$€£¥₹()0-9.,\s-]+)$/);
        if (spaceMatch) {
          const desc = spaceMatch[1].trim();
          if (!desc.toLowerCase().startsWith('invoice') && !desc.toLowerCase().startsWith('supplier')) {
            const qty = parseLocalizedAmount(spaceMatch[2]);
            const unitPrice = parseLocalizedAmount(spaceMatch[3]);
            const amount = parseLocalizedAmount(spaceMatch[4]);
            if (unitPrice === null || amount === null) continue;
            items.push({
              description: desc,
              quantity: qty,
              unit_price: unitPrice,
              amount,
              evidence: trimmed,
              page_reference: defaultPage,
            });
          }


        }
      }
    }

    return items;
  }
}

/**
 * Gemini LLM Extraction Adapter using @google/genai TypeScript SDK.
 * Supports configurable model, strict schema validation, and defensive timeout handling.
 */
export class GeminiExtractionAdapter implements ExtractionAdapter {
  private ai: GoogleGenAI | null = null;
  private model: string;

  constructor(apiKey?: string, model = getGoogleGenAIRuntimeEnvironment().GEMINI_MODEL || 'gemini-3.1-flash-lite') {
    this.model = model;
    this.ai = createGoogleGenAIClient(apiKey);
  }

  public async extract(
    documentText: string,
    options: ExtractionOptions = {}
  ): Promise<InvoiceExtractionResult> {
    const startTime = performance.now();
    const timeoutMs = options.timeoutMs || parseInt(getGoogleGenAIRuntimeEnvironment().EXTRACTION_TIMEOUT_MS || '30000', 10);
    const modelName = options.modelOverride || this.model;

    logSafe(`Executing GeminiExtractionAdapter with model ${modelName} (${documentText.length} chars)`);

    if (!this.ai) {
      throw new Error('GEMINI_API_KEY is not configured. Enable mock mode or provide GEMINI_API_KEY.');
    }

    const prompt = buildInvoiceExtractionPrompt(documentText);

    // Helper for executing generateContent with timeout
    const executeCall = async (modelToUse: string, msLimit: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Extraction timed out after ${msLimit}ms`)), msLimit);
      });
      try {
        // Promise.resolve().then(...) turns a synchronous throw into a rejection, so the timeout promise is
        // always attached to the race (previously a sync failure left it unhandled and crashed the process).
        const callPromise = Promise.resolve().then(() => this.ai!.models.generateContent({
          model: modelToUse,
          contents: prompt,
          config: {
            systemInstruction: INVOICE_EXTRACTION_SYSTEM_INSTRUCTION,
            responseMimeType: 'application/json',
            temperature: 0.1,
          },
        }));
        return await Promise.race([callPromise, timeoutPromise]);
      } finally {
        clearTimeout(timer);   // never leave the timer running (it also kept the process alive for up to 30 s)
      }
    };

    try {
      let response: any;
      try {
        response = await executeCall(modelName, timeoutMs);
      } catch (primaryErr) {
        const primaryErrMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
        // If primary model encountered a temporary spike (503), timeout, rate-limit, or quota exhaustion (429), attempt fast lite model fallback
        if (
          modelName !== 'gemini-3.1-flash-lite' &&
          (primaryErrMsg.includes('503') ||
            primaryErrMsg.includes('demand') ||
            primaryErrMsg.includes('timed out') ||
            primaryErrMsg.includes('429') ||
            primaryErrMsg.includes('Quota') ||
            primaryErrMsg.includes('RESOURCE_EXHAUSTED'))
        ) {
          logSafe(`Primary model ${modelName} unavailable (${primaryErrMsg.slice(0, 80)}). Retrying with gemini-3.1-flash-lite...`);
          response = await executeCall('gemini-3.1-flash-lite', Math.max(10000, timeoutMs));
        } else {
          throw primaryErr;
        }
      }

      const rawText = response.text || '{}';

      // Parse JSON safely
      let parsed: any;
      try {
        const cleaned = rawText.replace(/```json\n?|\n?```/g, '').trim();
        parsed = JSON.parse(cleaned);
      } catch (jsonErr) {
        throw new Error(`Model returned malformed JSON: ${String(jsonErr)}`, { cause: jsonErr });
      }

      const duration = Math.round(performance.now() - startTime);
      parsed.extraction_metadata = {
        mode: 'gemini_llm',
        model_used: modelName,
        processing_time_ms: duration,
        warnings: parsed.extraction_metadata?.warnings || [],
      };

      const validated = validateInvoiceExtraction(parsed, 'gemini_llm');
      // Code-level anti-hallucination guard: values not present in the source text are removed.
      return groundExtraction(validated.data, documentText).result;
    } catch (err) {
      const duration = Math.round(performance.now() - startTime);
      const errMsg = err instanceof Error ? err.message : String(err);
      logSafe(`Gemini extraction failed: ${errMsg}`);

      // Gracefully fall back to deterministic rule-based extractor so real invoice fields
      // are recovered without failing the document job
      try {
        const fallbackAdapter = new MockRuleBasedAdapter();
        const fallbackResult = await fallbackAdapter.extract(documentText, options);
        return {
          ...fallbackResult,
          extraction_metadata: {
            ...fallbackResult.extraction_metadata,
            // Honest labelling: this result came from the rule-based parser, not from the LLM.
            mode: 'mock_rule_based',
            model_used: `deterministic_rule_parser (fallback after ${modelName} failure)`,
            processing_time_ms: duration,
            warnings: [
              `Provider failure: ${errMsg}`,
              'Gracefully fell back to deterministic rule-based extractor.',
              ...(fallbackResult.extraction_metadata?.warnings || [])
            ],
          },
        };
      } catch {
        return {
          ...createEmptyExtractionResult('gemini_llm', [`Provider failure: ${errMsg}`]),
          extraction_metadata: {
            mode: 'gemini_llm',
            model_used: modelName,
            processing_time_ms: duration,
            warnings: [`Provider failure: ${errMsg}`],
          },
        };
      }
    }
  }
}

/**
 * Factory to instantiate the appropriate adapter based on configuration and environment.
 */
export class ExtractionFactory {
  public static createAdapter(forceMock = false): ExtractionAdapter {
    const env = getGoogleGenAIRuntimeEnvironment();
    const mode = env.EXTRACTION_MODE?.toLowerCase();

    if (forceMock || mode === 'mock') {
      return new MockRuleBasedAdapter();
    }

    if (!resolveGoogleGenAIOptions()) {
      return new MockRuleBasedAdapter();
    }

    const model = env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
    return new GeminiExtractionAdapter(env.GEMINI_API_KEY, model);
  }
}

/**
 * Defensive logging utility that suppresses full invoice contents by default.
 */
function logSafe(message: string): void {
  const allowSensitive = getGoogleGenAIRuntimeEnvironment().ENABLE_SENSITIVE_LOGGING === 'true';
  if (allowSensitive) {
    console.log(`[ExtractionService] ${message}`);
  } else {
    // Redact any potentially sensitive token or payload details
    const sanitized = message.replace(/(?:Invoice|Amount|Total|Supplier|INV-?)\s*[:=]?\s*[^\s,]+/gi, '[REDACTED]');
    console.log(`[ExtractionService] ${sanitized}`);
  }
}
