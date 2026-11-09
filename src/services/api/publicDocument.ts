/**
 * Public (serialisable) view of a DocumentRecord.
 * The in-memory record holds the full upload (`rawBuffer`) and the full OCR text. A Uint8Array serialises
 * to JSON as one object entry per byte (~11x the file size), so records must never be sent as-is.
 */
import type { DocumentRecord } from './types.ts';

export type PublicDocument = Omit<DocumentRecord, 'rawBuffer' | 'rawText' | 'storagePath'>;

export function toPublicDocument(doc: DocumentRecord): PublicDocument {
  const { rawBuffer: _rawBuffer, rawText: _rawText, storagePath: _storagePath, ...rest } = doc;
  return rest;
}
