/**
 * DocuPulse Frontend API Client
 * Wraps backend REST endpoints with strict typing, error sanitization, and base URL configuration.
 */

import {
  DocumentUploadResponse,
  DocumentMetadataResponse,
  DocumentResultResponse,
  DocumentListResponse,
  CorrectionRequest,
  CorrectionResponse,
  RetryResponse,
  HealthResponse,
  JobStatus,
} from '../services/api/types.ts';

// Configurable base URL via environment variable; supports empty (same-origin), root host, or /api/v1 paths
const rawBase = (import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/$/, '');
const API_BASE = rawBase.replace(/\/api\/v1\/?$/, '');

export class FrontendApiError extends Error {
  public code: string;
  public status: number;
  public field?: string;

  constructor(status: number, code: string, message: string, field?: string) {
    super(message);
    this.name = 'FrontendApiError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  let json: any;
  try {
    json = await res.json();
  } catch (_e) {
    throw new FrontendApiError(
      res.status,
      'INVALID_JSON_RESPONSE',
      `Server returned invalid response (status ${res.status}).`
    );
  }

  if (!res.ok) {
    const errObj = json?.error || {};
    throw new FrontendApiError(
      res.status,
      errObj.code || `HTTP_${res.status}`,
      errObj.message || json?.message || 'Server request failed.',
      errObj.field
    );
  }

  return json as T;
}

export const api = {
  /**
   * Ingests one or more documents (base64 payload)
   */
  async uploadDocuments(
    files: Array<{ name: string; size: number; type?: string; data: string }>
  ): Promise<DocumentUploadResponse> {
    const res = await fetch(`${API_BASE}/api/v1/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    });
    return handleResponse<DocumentUploadResponse>(res);
  },

  /**
   * Retrieves paginated list of documents with optional status & keyword filters
   */
  async listDocuments(params: {
    page?: number;
    limit?: number;
    status?: JobStatus;
    search?: string;
  } = {}): Promise<DocumentListResponse> {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.status) query.set('status', params.status);
    if (params.search && params.search.trim()) query.set('search', params.search.trim());

    const queryString = query.toString();
    const url = `${API_BASE}/api/v1/documents${queryString ? `?${queryString}` : ''}`;
    const res = await fetch(url);
    return handleResponse<DocumentListResponse>(res);
  },

  /**
   * Retrieves document metadata and current processing job status
   */
  async getDocumentMetadata(documentId: string): Promise<DocumentMetadataResponse> {
    const res = await fetch(`${API_BASE}/api/v1/documents/${encodeURIComponent(documentId)}`);
    return handleResponse<DocumentMetadataResponse>(res);
  },

  /**
   * Retrieves full extraction, validation, and audit trail results
   */
  async getDocumentResult(documentId: string): Promise<DocumentResultResponse> {
    const res = await fetch(`${API_BASE}/api/v1/documents/${encodeURIComponent(documentId)}/result`);
    return handleResponse<DocumentResultResponse>(res);
  },

  /**
   * Submits a validated manual correction with audit reason and author
   */
  async applyCorrections(
    documentId: string,
    corrections: Record<string, any>,
    reason?: string,
    revalidate: boolean = true
  ): Promise<CorrectionResponse> {
    const payload: CorrectionRequest = {
      corrections,
      reason,
      revalidate,
    };
    const res = await fetch(`${API_BASE}/api/v1/documents/${encodeURIComponent(documentId)}/corrections`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return handleResponse<CorrectionResponse>(res);
  },

  /**
   * Safely retries a failed or stalled document processing job
   */
  async retryDocument(documentId: string): Promise<RetryResponse> {
    const res = await fetch(`${API_BASE}/api/v1/documents/${encodeURIComponent(documentId)}/retry`, {
      method: 'POST',
    });
    return handleResponse<RetryResponse>(res);
  },

  /**
   * Cross-verifies two documents (e.g. PDF Invoice vs Excel PO / Delivery Log)
   */
  async crossVerify(sourceId: string, targetId: string): Promise<any> {
    const res = await fetch(`${API_BASE}/api/v1/documents/cross-verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId, targetId }),
    });
    return handleResponse<any>(res);
  },

  /**
   * Performs genuine vector semantic search over stored documents
   */
  async semanticSearch(query: string, minSimilarity = 0.2): Promise<any> {
    const q = encodeURIComponent(query.trim());
    const res = await fetch(`${API_BASE}/api/v1/documents/search/semantic?q=${q}&min_similarity=${minSimilarity}`);
    return handleResponse<any>(res);
  },

  /**
   * Checks system health and queue counts
   */
  async getHealth(): Promise<HealthResponse> {
    const res = await fetch(`${API_BASE}/health`);
    return handleResponse<HealthResponse>(res);
  },
};

