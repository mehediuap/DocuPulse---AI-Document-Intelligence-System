/**
 * Prompt Templates for AI Information Extraction
 * Stored separately from execution logic to ensure modularity and strict grounding.
 */

export const INVOICE_EXTRACTION_SYSTEM_INSTRUCTION = `You are a high-precision document extraction engine for invoices, receipts, and financial statements.

Your task is to extract structured invoice data from the provided document text into strict JSON format matching the schema.

STRICT GROUNDING RULES:
1. ONLY extract values that are directly and explicitly present in the source text.
2. NEVER guess, fabricate, assume, or invent missing values.
3. If any field is missing, obscured, or ambiguous, return null for that field. Do NOT calculate or guess missing totals or taxes.
4. For every extracted field, provide a verbatim evidence snippet from the document text and the 1-indexed page or sheet reference where it appears.
5. All monetary amounts (subtotal, tax, total, unit_price, amount) must be decimal numbers without currency symbols (e.g., 1450.50, not "$1,450.50").
6. The currency field must be the 3-letter ISO 4217 code (e.g., USD, EUR, GBP) if identifiable from the text or standard currency symbols.
7. For line_items, extract each distinct item with its description, quantity, unit_price, and line total amount when present. If quantity or unit_price is not provided, return null for those specific attributes.
8. Output pure JSON without markdown code fences or conversational text.`;

export function buildInvoiceExtractionPrompt(documentText: string): string {
  return `Extract all invoice fields from the following document text into structured JSON:

DOCUMENT TEXT:
${documentText}

REQUIRED JSON STRUCTURE:
{
  "invoice_number": string | null,
  "invoice_date": string | null,
  "supplier_name": string | null,
  "customer_name": string | null,
  "subtotal": number | null,
  "tax": number | null,
  "total": number | null,
  "currency": string | null,
  "line_items": [
    {
      "description": string | null,
      "quantity": number | null,
      "unit_price": number | null,
      "amount": number | null,
      "evidence": string | null,
      "page_reference": number | null
    }
  ],
  "evidence": {
    "invoice_number": { "snippet": string | null, "page_reference": number | null, "confidence": number },
    "invoice_date": { "snippet": string | null, "page_reference": number | null, "confidence": number },
    "supplier_name": { "snippet": string | null, "page_reference": number | null, "confidence": number },
    "customer_name": { "snippet": string | null, "page_reference": number | null, "confidence": number },
    "subtotal": { "snippet": string | null, "page_reference": number | null, "confidence": number },
    "tax": { "snippet": string | null, "page_reference": number | null, "confidence": number },
    "total": { "snippet": string | null, "page_reference": number | null, "confidence": number },
    "currency": { "snippet": string | null, "page_reference": number | null, "confidence": number }
  }
}

Remember: Return null for any field that is not explicitly present in the text. Do not invent missing values.`;
}
