/**
 * REST API Request & Response Types
 * Synchronized with schemas/api_models.py
 */

import { InvoiceExtractionResult } from '../extraction/schemas.ts';
import { ValidationSummary } from '../validation/types.ts';

export type JobStatus = 'queued' | 'processing' | 'completed' | 'needs_review' | 'invalid' | 'failed';

export interface DocumentRecord {
  id: string;
  originalFilename: string;
  sanitizedFilename: string;
  fileType: string;
  mimeType: string;
  fileSizeBytes: number;
  rawBuffer?: Uint8Array;
  storagePath?: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  processingDurationMs?: number;
  retryCount: number;
  isRetrying?: boolean;

  // Processing results
  rawText?: string;
  extraction?: InvoiceExtractionResult | null;
  validation?: ValidationSummary | null;
  auditTrail: AuditEntry[];
  errors: string[];
  warnings: string[];
}

export interface AuditEntry {
  field: string;
  previousValue: any;
  newValue: any;
  updatedAt: string;
  reason?: string;
  author: string;
}

export interface DocumentUploadResponse {
  success: boolean;
  documents: Array<{
    documentId: string;
    filename: string;
    status: JobStatus;
    message: string;
  }>;
  totalQueued: number;
}

export interface DocumentMetadataResponse {
  id: string;
  originalFilename: string;
  sanitizedFilename: string;
  fileType: string;
  mimeType: string;
  fileSizeBytes: number;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  processingDurationMs?: number;
  retryCount: number;
}

export interface DocumentResultResponse {
  documentId: string;
  status: JobStatus;
  extraction: InvoiceExtractionResult | null;
  validation: ValidationSummary | null;
  auditTrail: AuditEntry[];
  errors: string[];
  warnings: string[];
}

export interface DocumentListResponse {
  items: DocumentMetadataResponse[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface CorrectionRequest {
  corrections: Record<string, any>;
  reason?: string;
  revalidate?: boolean;
}

export interface CorrectionResponse {
  success: boolean;
  documentId: string;
  status: JobStatus;
  updatedFields: string[];
  auditTrail: AuditEntry[];
  validationStatus: string;
}

export interface RetryResponse {
  success: boolean;
  documentId: string;
  status: JobStatus;
  message: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  service: string;
  environment: string;
  databaseStatus: 'connected' | 'disconnected';
  queueStatus: {
    queued: number;
    processing: number;
    completed: number;
    needs_review: number;
    invalid: number;
    failed: number;
    total: number;
  };
  authWarning: string;
}
