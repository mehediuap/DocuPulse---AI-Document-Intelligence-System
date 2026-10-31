/**
 * TypeScript Schema Definitions & Runtime Validation for AI Information Extraction
 */

export interface LineItemExtraction {
  description: string | null;
  quantity: number | null;
  unit_price: number | null;
  amount: number | null;
  evidence?: string | null;
  page_reference?: number | null;
}

export type InvoiceLineItem = LineItemExtraction;

export interface FieldEvidenceItem {
  snippet: string | null;
  page_reference: number | null;
  confidence: number;
}

export interface ExtractionMetadataInfo {
  mode: 'mock_rule_based' | 'gemini_llm';
  model_used?: string;
  processing_time_ms: number;
  warnings: string[];
  schemaIssues?: ValidationIssue[];
}

export interface InvoiceExtractionResult {
  invoice_number: string | null;
  invoice_date: string | null;
  supplier_name: string | null;
  customer_name: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  currency: string | null;
  line_items: LineItemExtraction[];
  evidence: Record<string, FieldEvidenceItem>;
  extraction_metadata: ExtractionMetadataInfo;
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface SchemaValidationResult {
  isValid: boolean;
  data: InvoiceExtractionResult;
  issues: ValidationIssue[];
}

/**
 * Validates and normalizes raw model or rule-based output against the invoice extraction schema.
 * Handles missing fields, invalid types, and malformed structures safely.
 */
export function validateInvoiceExtraction(
  raw: any,
  mode: 'mock_rule_based' | 'gemini_llm' = 'mock_rule_based',
  sourceText?: string
): SchemaValidationResult {
  const issues: ValidationIssue[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      isValid: false,
      issues: [{ field: 'root', message: 'Extraction payload must be a non-null JSON object.', severity: 'error' }],
      data: createEmptyExtractionResult(mode, ['Payload was not a valid object.']),
    };
  }

  // 1. Text Fields
  const invoice_number = parseStringOrNull(raw.invoice_number);
  const invoice_date = parseStringOrNull(raw.invoice_date);
  const supplier_name = parseStringOrNull(raw.supplier_name);
  const customer_name = parseStringOrNull(raw.customer_name);
  const currency = normalizeCurrency(raw.currency);

  // 2. Financial Amount Fields (decimal-safe numeric parsing)
  const subtotal = parseDecimalOrNull(raw.subtotal);
  const tax = parseDecimalOrNull(raw.tax);
  const total = parseDecimalOrNull(raw.total);
  for (const [field, rawValue, parsedValue] of [
    ['subtotal', raw.subtotal, subtotal],
    ['tax', raw.tax, tax],
    ['total', raw.total, total],
  ] as const) {
    if (hasMeaningfulValue(rawValue) && parsedValue === null) {
      issues.push({
        field,
        message: `Field "${field}" contains a malformed or out-of-range amount.`,
        severity: 'error',
      });
    }
  }

  // 3. Line Items Validation
  const line_items: LineItemExtraction[] = [];
  if (Array.isArray(raw.line_items)) {
    for (let i = 0; i < raw.line_items.length; i++) {
      const item = raw.line_items[i];
      if (typeof item === 'object' && item !== null) {
        const quantity = parseDecimalOrNull(item.quantity);
        const unitPrice = parseDecimalOrNull(item.unit_price);
        const amount = parseDecimalOrNull(item.amount);
        for (const [field, value, parsedValue] of [
          ['quantity', item.quantity, quantity],
          ['unit_price', item.unit_price, unitPrice],
          ['amount', item.amount, amount],
        ] as const) {
          if (hasMeaningfulValue(value) && parsedValue === null) {
            issues.push({
              field: `line_items[${i}].${field}`,
              message: `Line item ${i + 1} has a malformed or out-of-range ${field}.`,
              severity: 'error',
            });
          }
        }
        line_items.push({
          description: parseStringOrNull(item.description),
          quantity,
          unit_price: unitPrice,
          amount,
          evidence: parseStringOrNull(item.evidence),
          page_reference: parseIntegerOrNull(item.page_reference),
        });
      } else {
        issues.push({
          field: `line_items[${i}]`,
          message: 'Malformed line item entry; expected object.',
          severity: 'warning',
        });
      }
    }
  }

  // 4. Evidence Validation
  const warnings: string[] = [];
  const evidence: Record<string, FieldEvidenceItem> = {};
  if (raw.evidence && typeof raw.evidence === 'object') {
    for (const [key, val] of Object.entries(raw.evidence)) {
      if (typeof val === 'object' && val !== null) {
        const v = val as any;
        evidence[key] = {
          snippet: parseStringOrNull(v.snippet),
          page_reference: parseIntegerOrNull(v.page_reference),
          confidence: typeof v.confidence === 'number' && Number.isFinite(v.confidence) ? Math.max(0, Math.min(1, v.confidence)) : 0,
        };
      }
    }
  }

  // 5. Warnings and notices
  if (Array.isArray(raw.extraction_metadata?.warnings)) {
    warnings.push(...raw.extraction_metadata.warnings.filter((warning: unknown): warning is string => typeof warning === 'string'));
  }

  const metadataMode = raw.extraction_metadata?.mode;
  const processingTime = raw.extraction_metadata?.processing_time_ms;
  const resultData: InvoiceExtractionResult = {
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
      mode: metadataMode === 'gemini_llm' || metadataMode === 'mock_rule_based' ? metadataMode : mode,
      model_used: typeof raw.extraction_metadata?.model_used === 'string' ? raw.extraction_metadata.model_used : 'default',
      processing_time_ms: typeof processingTime === 'number' && Number.isFinite(processingTime) && processingTime >= 0
        ? processingTime
        : 0,
      warnings,
      schemaIssues: issues,
    },
  };
  for (const issue of issues) {
    if (issue.severity === 'error') warnings.push(issue.message);
  }
  if (sourceText !== undefined) verifyExtractionEvidence(resultData, sourceText);

  const hasCriticalErrors = issues.some(i => i.severity === 'error');

  return {
    isValid: !hasCriticalErrors,
    data: resultData,
    issues,
  };
}

export function verifyExtractionEvidence(
  extraction: InvoiceExtractionResult,
  sourceText: string
): string[] {
  const sourceSections = getEvidenceSections(sourceText);
  const warnings: string[] = [];
  const fields: Array<[string, string | number | null]> = [
    ['invoice_number', extraction.invoice_number],
    ['invoice_date', extraction.invoice_date],
    ['supplier_name', extraction.supplier_name],
    ['customer_name', extraction.customer_name],
    ['subtotal', extraction.subtotal],
    ['tax', extraction.tax],
    ['total', extraction.total],
    ['currency', extraction.currency],
  ];

  for (const [field, value] of fields) {
    if (value === null) continue;
    const item = extraction.evidence[field];
    const snippet = item?.snippet ? normalizeEvidenceText(item.snippet) : '';
    const section = findEvidenceSection(sourceSections, snippet);
    const sourceContainsSnippet = section !== null;
    const snippetSupportsValue = typeof value === 'number'
      ? evidenceContainsAmount(value, item?.snippet || '')
      : snippet.includes(normalizeEvidenceText(value));
    const pageReferenceMatches = item?.page_reference == null ||
      (section !== null && item.page_reference === section.pageReference);
    if (!sourceContainsSnippet || !snippetSupportsValue || !pageReferenceMatches) {
      extraction.evidence[field] = {
        snippet: item?.snippet || null,
        page_reference: null,
        confidence: 0,
      };
      warnings.push(`Evidence for "${field}" could not be verified against the parsed document text.`);
    } else {
      extraction.evidence[field] = {
        ...item,
        page_reference: section.pageReference,
      };
    }
  }

  for (const [index, item] of extraction.line_items.entries()) {
    const snippet = item.evidence || '';
    const normalizedSnippet = normalizeEvidenceText(snippet);
    const section = findEvidenceSection(sourceSections, normalizedSnippet);
    const sourceContainsSnippet = section !== null;
    const supportsDescription = item.description
      ? normalizedSnippet.includes(normalizeEvidenceText(item.description))
      : true;
    const supportsAmounts = [item.amount, item.unit_price, item.quantity]
      .filter((value): value is number => value !== null)
      .every(value => evidenceContainsAmount(value, snippet));
    const pageReferenceMatches = item.page_reference == null ||
      (section !== null && item.page_reference === section.pageReference);
    if (!sourceContainsSnippet || !supportsDescription || !supportsAmounts || !pageReferenceMatches) {
      item.page_reference = null;
      extraction.evidence[`line_items[${index}]`] = {
        snippet: item.evidence || null,
        page_reference: null,
        confidence: 0,
      };
      warnings.push(`Evidence for line item ${index + 1} could not be verified against the parsed document text.`);
    } else {
      item.page_reference = section.pageReference;
    }
  }
  extraction.extraction_metadata.warnings.push(...warnings);
  return warnings;
}

interface EvidenceSection {
  pageReference: number;
  text: string;
}

function getEvidenceSections(sourceText: string): EvidenceSection[] {
  const markerPattern = /---\s*PAGE\s+(\d+)\s*---|---\s*WORKSHEET:\s*([^\r\n]*?)\s*---/gi;
  const markers = Array.from(sourceText.matchAll(markerPattern));
  if (markers.length === 0) return [{ pageReference: 1, text: sourceText }];

  let worksheetReference = 0;
  return markers.map((marker, index) => {
    const pageReference = marker[1]
      ? Number(marker[1])
      : ++worksheetReference;
    const start = (marker.index ?? 0) + marker[0].length;
    const end = markers[index + 1]?.index ?? sourceText.length;
    return { pageReference, text: sourceText.slice(start, end) };
  });
}

function findEvidenceSection(
  sections: EvidenceSection[],
  normalizedSnippet: string
): EvidenceSection | null {
  if (!normalizedSnippet) return null;
  return sections.find(section =>
    containsEvidenceSnippet(normalizeEvidenceText(section.text), normalizedSnippet)
  ) ?? null;
}

function containsEvidenceSnippet(source: string, snippet: string): boolean {
  let start = source.indexOf(snippet);
  while (start >= 0) {
    const end = start + snippet.length;
    const startsInsideWord = start > 0 && /[a-z0-9]/i.test(source[start - 1]) && /[a-z0-9]/i.test(snippet[0]);
    const endsInsideWord = end < source.length &&
      /[a-z0-9]/i.test(source[end]) &&
      /[a-z0-9]/i.test(snippet[snippet.length - 1]);
    if (!startsInsideWord && !endsInsideWord) return true;
    start = source.indexOf(snippet, start + 1);
  }
  return false;
}

function normalizeEvidenceText(value: string | number): string {
  return String(value)
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function evidenceContainsAmount(amount: number, snippet: string): boolean {
  const tokens = snippet.match(/[-+]?\(?\d[\d.,'’ ]*\d?\)?/g) || [];
  return tokens.some(token => {
    let value = token.replace(/['’ ]/g, '');
    const negative = value.startsWith('-') || (value.startsWith('(') && value.endsWith(')'));
    value = value.replace(/[()+-]/g, '');
    const comma = value.lastIndexOf(',');
    const dot = value.lastIndexOf('.');
    let decimalSeparator: ',' | '.' | null = null;
    if (comma >= 0 && dot >= 0) decimalSeparator = comma > dot ? ',' : '.';
    else {
      const separator = comma >= 0 ? ',' : dot >= 0 ? '.' : null;
      if (separator) {
        const trailingDigits = value.length - value.lastIndexOf(separator) - 1;
        if (trailingDigits > 0 && trailingDigits <= 2) decimalSeparator = separator;
      }
    }
    if (decimalSeparator) {
      const groupingSeparator = decimalSeparator === ',' ? '.' : ',';
      value = value.split(groupingSeparator).join('');
      if (decimalSeparator === ',') value = value.replace(',', '.');
    } else {
      value = value.replace(/[.,]/g, '');
    }
    const parsed = Number(value) * (negative ? -1 : 1);
    return Number.isFinite(parsed) && Math.round(parsed * 100) === Math.round(amount * 100);
  });
}

export function createEmptyExtractionResult(
  mode: 'mock_rule_based' | 'gemini_llm',
  warnings: string[] = []
): InvoiceExtractionResult {
  return {
    invoice_number: null,
    invoice_date: null,
    supplier_name: null,
    customer_name: null,
    subtotal: null,
    tax: null,
    total: null,
    currency: null,
    line_items: [],
    evidence: {},
    extraction_metadata: {
      mode,
      processing_time_ms: 0,
      warnings,
    },
  };
}

function parseStringOrNull(val: any): string | null {
  if (typeof val !== 'string') return null;
  const str = val.trim();
  if (!str || str.toLowerCase() === 'null' || str.toLowerCase() === 'unknown' || str.toLowerCase() === 'n/a') {
    return null;
  }
  return str;
}

function parseDecimalOrNull(val: any): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') {
    return Number.isFinite(val) ? roundToCents(val) : null;
  }
  if (typeof val !== 'string') return null;
  let str = val
    .replace(/(?:USD|CAD|AUD|NZD|EUR|GBP|JPY|CNY|INR|CHF|SGD|HKD)/gi, '')
    .replace(/[$€£¥₹]/g, '')
    .replace(/[\u00a0\s'’]/g, '')
    .trim();
  if (!str || ['null', 'unknown', 'n/a'].includes(str.toLowerCase())) {
    return null;
  }
  const isParenthesizedNegative = str.startsWith('(') && str.endsWith(')');
  if (isParenthesizedNegative) str = str.slice(1, -1);
  const sign = str.startsWith('-') || isParenthesizedNegative ? -1 : 1;
  str = str.replace(/^[+-]/, '');
  if (!/^\d[\d.,]*$/.test(str)) return null;

  const comma = str.lastIndexOf(',');
  const dot = str.lastIndexOf('.');
  let decimalSeparator: ',' | '.' | null = null;
  if (comma >= 0 && dot >= 0) {
    decimalSeparator = comma > dot ? ',' : '.';
  } else {
    const separator = comma >= 0 ? ',' : dot >= 0 ? '.' : null;
    if (separator) {
      const count = str.split(separator).length - 1;
      const trailingDigits = str.length - str.lastIndexOf(separator) - 1;
      if (count === 1 && trailingDigits > 0 && trailingDigits <= 2) {
        decimalSeparator = separator;
      } else if (count > 1) {
        const groups = str.split(separator);
        const validGrouping = groups[0].length >= 1 && groups[0].length <= 3 &&
          groups.slice(1).every(group => /^\d{3}$/.test(group));
        if (!validGrouping) return null;
      } else if (count === 1 && trailingDigits !== 3) {
        return null;
      }
    }
  }

  let normalized = str;
  if (decimalSeparator) {
    if (str.length - str.lastIndexOf(decimalSeparator) - 1 > 2) return null;
    const groupingSeparator = decimalSeparator === ',' ? '.' : ',';
    const decimalIndex = str.lastIndexOf(decimalSeparator);
    const integerPart = str.slice(0, decimalIndex);
    const groups = integerPart.split(groupingSeparator);
    if (groups.length > 1 && (groups[0].length < 1 || groups[0].length > 3 ||
      groups.slice(1).some(group => group.length !== 3))) return null;
    normalized = `${integerPart.split(groupingSeparator).join('')}.${str.slice(decimalIndex + 1)}`;
    if (normalized.endsWith('.')) return null;
  } else {
    normalized = str.replace(/[.,]/g, '');
  }
  const parsed = Number(normalized) * sign;
  return Number.isFinite(parsed) ? roundToCents(parsed) : null;
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'string') return true;
  return !['', 'null', 'unknown', 'n/a'].includes(value.trim().toLowerCase());
}

function parseIntegerOrNull(val: any): number | null {
  if (val === null || val === undefined) return null;
  const num = typeof val === 'number' ? val : typeof val === 'string' && /^\d+$/.test(val) ? Number(val) : NaN;
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}

function roundToCents(val: number): number | null {
  const cents = Math.round(val * 100);
  return Number.isSafeInteger(cents) ? cents / 100 : null;
}

function normalizeCurrency(raw: any): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const str = raw.trim().toUpperCase();
  const map: Record<string, string> = {
    '€': 'EUR',
    '£': 'GBP',
    '₹': 'INR',
  };
  if (str === '$' || str === '¥') return null;
  return map[str] || ( /^[A-Z]{3}$/.test(str) ? str : null);
}
