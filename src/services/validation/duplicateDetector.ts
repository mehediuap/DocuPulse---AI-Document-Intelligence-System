/**
 * Duplicate Invoice Candidate Detector
 * Identifies duplicate or collision candidates based on supplier and invoice number pairs.
 * 
 * Documented Limitations:
 * - Operates across in-memory batches and provided historical invoice records.
 * - Multi-tenant or persistent cross-session duplicate verification requires database integration.
 * - Spelling variations outside standard legal suffixes (Inc, Ltd, LLC, Corp) may require fuzzy matching.
 */

import { InvoiceExtractionResult } from '../extraction/schemas.ts';

export interface DuplicateMatchResult {
  isDuplicate: boolean;
  confidence: number;
  matchedInvoiceNumber: string;
  matchedSupplierName: string;
  matchedDocumentId?: string;
  reasons: string[];
}

export class DuplicateDetector {
  /**
   * Checks whether a candidate invoice matches any previously processed invoice record.
   */
  public static findDuplicate(
    candidate: InvoiceExtractionResult,
    existingInvoices: InvoiceExtractionResult[] = []
  ): DuplicateMatchResult | null {
    if (!candidate.invoice_number || !candidate.supplier_name) {
      // Cannot reliably flag a duplicate without both supplier and invoice number
      return null;
    }

    const normCandidateSupplier = normalizeSupplierName(candidate.supplier_name);
    const normCandidateNumber = normalizeInvoiceNumber(candidate.invoice_number);

    for (const existing of existingInvoices) {
      // Avoid matching against self if comparing in a collection
      if (!existing.invoice_number || !existing.supplier_name) continue;

      const normExistingSupplier = normalizeSupplierName(existing.supplier_name);
      const normExistingNumber = normalizeInvoiceNumber(existing.invoice_number);

      const supplierMatches = normCandidateSupplier === normExistingSupplier;
      const numberMatches = normCandidateNumber === normExistingNumber;

      if (supplierMatches && numberMatches) {
        const reasons: string[] = [
          `Identical normalized supplier "${normCandidateSupplier}" and invoice number "${normCandidateNumber}".`
        ];

        // Cross-check amounts if present
        if (candidate.total !== null && existing.total !== null) {
          if (candidate.total === existing.total) {
            reasons.push(`Matching total monetary amount of ${candidate.currency || ''} ${candidate.total}.`);
          } else {
            reasons.push(`Note: Stated totals differ (${candidate.total} vs ${existing.total}); possible revision or billing collision.`);
          }
        }

        // Cross-check dates if present
        if (candidate.invoice_date && existing.invoice_date && candidate.invoice_date === existing.invoice_date) {
          reasons.push(`Matching issue date: ${candidate.invoice_date}.`);
        }

        return {
          isDuplicate: true,
          confidence: 0.99,
          matchedInvoiceNumber: existing.invoice_number,
          matchedSupplierName: existing.supplier_name,
          reasons,
        };
      }
    }

    return null;
  }
}

/**
 * Normalizes company and supplier names by stripping legal entities, punctuation, and casing.
 */
export function normalizeSupplierName(name: string): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, ' ')
    .replace(/\b(inc|incorporated|ltd|limited|llc|corp|corporation|gmbh|co|company|sa|plc)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes invoice identifiers by removing formatting symbols, prefixes, and punctuation.
 */
export function normalizeInvoiceNumber(num: string): string {
  if (!num) return '';
  return num
    .toLowerCase()
    .replace(/^(?:inv|invoice|bill|doc|no|num|#)[\s\-_:]*/i, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}
