/**
 * Document API Controller
 * Encapsulates core business logic for all /api/v1/documents endpoints.
 */

import {
  DocumentRecord,
  DocumentUploadResponse,
  DocumentMetadataResponse,
  DocumentResultResponse,
  DocumentListResponse,
  CorrectionRequest,
  CorrectionResponse,
  RetryResponse,
  HealthResponse,
  JobStatus,
  AuditEntry,
} from './types.ts';
import { BackgroundJobQueue } from '../queue/jobQueue.ts';
import { sanitizeFilename, validateFileBounds, detectFileType } from '../document/security.ts';
import { ValidationService } from '../validation/validationService.ts';
import { CrossVerificationService, CrossVerificationResult } from '../validation/crossVerification.ts';
import { semanticSearchService, SemanticSearchResponse } from '../search/semanticSearch.ts';
import { documentRepository, DocumentRepository } from '../../db/repository.ts';
import {
  DocumentSourceStorage,
  MemoryDocumentSourceStorage,
  documentSourceStorage,
} from '../document/sourceStorage.ts';
import { InvoiceExtractionResult } from '../extraction/schemas.ts';
import { roundToTwoDecimals } from '../validation/decimalUtils.ts';

export class DocumentController {
  private documentStore = new Map<string, DocumentRecord>();
  private jobQueue: BackgroundJobQueue;
  private repository: DocumentRepository;
  private sourceStorage: DocumentSourceStorage;

  constructor(customRepo?: DocumentRepository, customStorage?: DocumentSourceStorage) {
    this.repository = customRepo || documentRepository;
    this.sourceStorage = customStorage || (customRepo ? new MemoryDocumentSourceStorage() : documentSourceStorage);
    this.jobQueue = new BackgroundJobQueue(this.documentStore, this.repository);
    this.hydrateFromDb();
  }

  /**
   * Hydrates in-memory cache with persisted SQLite documents on startup.
   */
  private hydrateFromDb(): void {
    const interruptedDocuments: DocumentRecord[] = [];
    for (const doc of this.repository.getAllDocuments()) {
      doc.rawBuffer = doc.storagePath ? this.sourceStorage.read(doc.storagePath) : undefined;
      this.documentStore.set(doc.id, doc);

      if (doc.status === 'queued' || doc.status === 'processing') {
        if (!doc.rawBuffer) {
          doc.status = 'failed';
          doc.errors.push('Original source file is unavailable; interrupted job cannot be resumed.');
          doc.updatedAt = new Date().toISOString();
          this.repository.saveJobState(doc, doc.retryCount + 1, 'failed', 0, doc.errors[doc.errors.length - 1]);
          continue;
        }

        if (doc.status === 'processing') doc.retryCount += 1;
        doc.status = 'queued';
        doc.updatedAt = new Date().toISOString();
        this.repository.saveJobState(doc, doc.retryCount + 1, 'queued');
        interruptedDocuments.push(doc);
      }
    }
    for (const doc of interruptedDocuments) this.jobQueue.enqueue(doc.id);
  }

  public getRepository(): DocumentRepository {
    return this.repository;
  }

  public getQueue(): BackgroundJobQueue {
    return this.jobQueue;
  }

  public getStore(): Map<string, DocumentRecord> {
    return this.documentStore;
  }

  /**
   * POST /api/v1/documents
   * Ingests one or multiple files, performs bounds checking, creates jobs, and enqueues them.
   */
  public async uploadDocuments(
    files: Array<{ name: string; size: number; type?: string; buffer: Uint8Array }>
  ): Promise<DocumentUploadResponse> {
    if (!files || files.length === 0) {
      throw new HttpError(400, 'NO_FILES_PROVIDED', 'At least one file must be uploaded.');
    }

    const validatedFiles = files.map(file => {
      if (!(file.buffer instanceof Uint8Array)) {
        throw new HttpError(400, 'INVALID_FILE_DATA', 'Uploaded file data must be a byte buffer.', 'file');
      }
      if (file.size !== file.buffer.byteLength) {
        throw new HttpError(400, 'FILE_SIZE_MISMATCH', 'Declared file size does not match uploaded bytes.', 'size');
      }
      const sanitizedName = sanitizeFilename(file.name);
      const bounds = validateFileBounds(file.buffer.byteLength);

      if (!bounds.valid) {
        throw new HttpError(400, 'INVALID_FILE_BOUNDS', bounds.error || 'File bounds invalid.', 'size');
      }

      const fileType = detectFileType(sanitizedName, file.buffer.slice(0, 16));
      if (fileType === 'unsupported') {
        throw new HttpError(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          `Format not supported for file "${file.name}". Supported: PDF, JPG, PNG, TIFF, XLSX, XLS, CSV.`,
          'file'
        );
      }

      return { file, sanitizedName, fileType };
    });

    const items: DocumentUploadResponse['documents'] = [];

    for (const { file, sanitizedName, fileType } of validatedFiles) {
      const docId = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const now = new Date().toISOString();
      const rawBuffer = new Uint8Array(file.buffer);
      const storagePath = this.sourceStorage.save(docId, rawBuffer);

      const record: DocumentRecord = {
        id: docId,
        originalFilename: file.name,
        sanitizedFilename: sanitizedName,
        fileType,
        mimeType: file.type || 'application/octet-stream',
        fileSizeBytes: file.size,
        rawBuffer,
        storagePath,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        retryCount: 0,
        auditTrail: [],
        errors: [],
        warnings: [],
      };

      try {
        this.repository.saveJobState(record, 1, 'queued');
      } catch (error) {
        this.sourceStorage.remove(storagePath);
        throw error;
      }
      this.documentStore.set(docId, record);
      this.jobQueue.enqueue(docId);

      items.push({
        documentId: docId,
        filename: sanitizedName,
        status: 'queued',
        message: 'File accepted and processing job queued.',
      });
    }

    return {
      success: true,
      documents: items,
      totalQueued: items.length,
    };
  }

  /**
   * GET /api/v1/documents/:document_id
   */
  public getDocumentMetadata(documentId: string): DocumentMetadataResponse {
    const doc = this.documentStore.get(documentId);
    if (!doc) {
      throw new HttpError(404, 'DOCUMENT_NOT_FOUND', `Document with ID "${documentId}" was not found.`);
    }

    return {
      id: doc.id,
      originalFilename: doc.originalFilename,
      sanitizedFilename: doc.sanitizedFilename,
      fileType: doc.fileType,
      mimeType: doc.mimeType,
      fileSizeBytes: doc.fileSizeBytes,
      status: doc.status,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      processingDurationMs: doc.processingDurationMs,
      retryCount: doc.retryCount,
    };
  }

  /**
   * GET /api/v1/documents/:document_id/result
   */
  public getDocumentResult(documentId: string): DocumentResultResponse {
    const doc = this.documentStore.get(documentId);
    if (!doc) {
      throw new HttpError(404, 'DOCUMENT_NOT_FOUND', `Document with ID "${documentId}" was not found.`);
    }

    return {
      documentId: doc.id,
      status: doc.status,
      extraction: doc.extraction || null,
      validation: doc.validation || null,
      auditTrail: doc.auditTrail,
      errors: doc.errors,
      warnings: doc.warnings,
    };
  }

  /**
   * GET /api/v1/documents (paginated list, filter by status, search by keyword)
   */
  public listDocuments(options: {
    page?: number;
    limit?: number;
    status?: JobStatus;
    search?: string;
  }): DocumentListResponse {
    const page = Math.max(1, Number.isFinite(options.page) ? Math.floor(options.page!) : 1);
    const limit = Math.max(1, Math.min(100, Number.isFinite(options.limit) ? Math.floor(options.limit!) : 10));
    const result = this.repository.searchDocuments({
      page,
      limit,
      status: options.status,
      search: options.search?.trim(),
    });
    const paginatedItems = result.items.map(d => ({
      id: d.id,
      originalFilename: d.originalFilename,
      sanitizedFilename: d.sanitizedFilename,
      fileType: d.fileType,
      mimeType: d.mimeType,
      fileSizeBytes: d.fileSizeBytes,
      status: d.status,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      processingDurationMs: d.processingDurationMs,
      retryCount: d.retryCount,
    }));

    return {
      items: paginatedItems,
      total: result.total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(result.total / limit)),
    };
  }

  /**
   * PATCH /api/v1/documents/:document_id/corrections
   * Applies validated manual corrections with audit logging.
   */
  public applyCorrections(
    documentId: string,
    req: CorrectionRequest
  ): CorrectionResponse {
    const doc = this.documentStore.get(documentId);
    if (!doc) {
      throw new HttpError(404, 'DOCUMENT_NOT_FOUND', `Document with ID "${documentId}" was not found.`);
    }

    if (!doc.extraction) {
      throw new HttpError(400, 'NO_EXTRACTION_DATA', 'Cannot apply corrections to a document without extracted data.');
    }

    if (!req || typeof req !== 'object' || Array.isArray(req) ||
      !req.corrections || typeof req.corrections !== 'object' ||
      Array.isArray(req.corrections) || Object.keys(req.corrections).length === 0) {
      throw new HttpError(400, 'INVALID_CORRECTIONS_PAYLOAD', 'Corrections mapping must contain at least one field.', 'corrections');
    }
    if (req.revalidate !== undefined && typeof req.revalidate !== 'boolean') {
      throw new HttpError(400, 'INVALID_REVALIDATE_FLAG', 'The revalidate property must be a boolean.', 'revalidate');
    }
    if (req.reason !== undefined && (typeof req.reason !== 'string' || req.reason.length > 1000)) {
      throw new HttpError(400, 'INVALID_CORRECTION_REASON', 'Correction reason must be text no longer than 1000 characters.', 'reason');
    }

    const editableTextFields = new Set(['invoice_number', 'invoice_date', 'supplier_name', 'customer_name', 'currency']);
    const editableAmountFields = new Set(['subtotal', 'tax', 'total']);
    const now = new Date().toISOString();
    const extraction: InvoiceExtractionResult = { ...doc.extraction };
    const updatedFields: string[] = [];
    const auditEntries: AuditEntry[] = [];

    for (const [field, newVal] of Object.entries(req.corrections)) {
      if (!editableTextFields.has(field) && !editableAmountFields.has(field)) {
        throw new HttpError(422, 'UNRECOGNIZED_FIELD', `Field "${field}" is not a valid schema property.`);
      }

      let prevVal: unknown;
      let correctedValue: unknown;
      if (editableTextFields.has(field)) {
        if (newVal !== null && typeof newVal !== 'string') {
          throw new HttpError(422, 'INVALID_CORRECTION_VALUE', `Field "${field}" must be text or null.`, field);
        }
        if (typeof newVal === 'string' && newVal.length > 500) {
          throw new HttpError(422, 'INVALID_CORRECTION_VALUE', `Field "${field}" exceeds the 500 character limit.`, field);
        }
        const textValue = typeof newVal === 'string' ? newVal.trim() || null : null;
        if (field === 'currency' && textValue && !/^[A-Za-z]{3}$/.test(textValue) &&
          !['$', '€', '£', '¥', '₹'].includes(textValue)) {
          throw new HttpError(422, 'INVALID_CORRECTION_VALUE', 'Currency must be an ISO 4217 code or a supported currency symbol.', field);
        }
        switch (field) {
          case 'invoice_number': prevVal = extraction.invoice_number; extraction.invoice_number = textValue; correctedValue = textValue; break;
          case 'invoice_date': prevVal = extraction.invoice_date; extraction.invoice_date = textValue; correctedValue = textValue; break;
          case 'supplier_name': prevVal = extraction.supplier_name; extraction.supplier_name = textValue; correctedValue = textValue; break;
          case 'customer_name': prevVal = extraction.customer_name; extraction.customer_name = textValue; correctedValue = textValue; break;
          case 'currency': {
            const currency = textValue?.toUpperCase();
            const symbols: Record<string, string> = { '€': 'EUR', '£': 'GBP', '₹': 'INR' };
            prevVal = extraction.currency;
            extraction.currency = currency ? symbols[currency] || (/^[A-Z]{3}$/.test(currency) && currency !== '$' && currency !== '¥' ? currency : null) : null;
            correctedValue = extraction.currency;
            break;
          }
        }
      } else {
        let amount: number | null;
        if (newVal === null) {
          amount = null;
        } else if (typeof newVal === 'number' && Number.isFinite(newVal)) {
          if (!Number.isSafeInteger(Math.round(newVal * 100))) {
            throw new HttpError(422, 'INVALID_CORRECTION_VALUE', `Field "${field}" exceeds the supported monetary range.`, field);
          }
          amount = roundToTwoDecimals(newVal);
        } else if (typeof newVal === 'string' && /^-?(?:\d+\.?\d*|\.\d+)$/.test(newVal.trim()) && Number.isFinite(Number(newVal))) {
          if (!Number.isSafeInteger(Math.round(Number(newVal) * 100))) {
            throw new HttpError(422, 'INVALID_CORRECTION_VALUE', `Field "${field}" exceeds the supported monetary range.`, field);
          }
          amount = roundToTwoDecimals(Number(newVal));
        } else {
          throw new HttpError(422, 'INVALID_CORRECTION_VALUE', `Field "${field}" must be a finite number or null.`, field);
        }
        switch (field) {
          case 'subtotal': prevVal = extraction.subtotal; extraction.subtotal = amount; correctedValue = amount; break;
          case 'tax': prevVal = extraction.tax; extraction.tax = amount; correctedValue = amount; break;
          case 'total': prevVal = extraction.total; extraction.total = amount; correctedValue = amount; break;
        }
      }

      const auditEntry: AuditEntry = {
        field,
        previousValue: prevVal,
        newValue: correctedValue,
        updatedAt: now,
        reason: req.reason || 'Manual auditor correction',
        author: 'auditor',
      };
      auditEntries.push(auditEntry);
      updatedFields.push(field);
    }

    let validation = doc.validation;
    let status = doc.status;
    if (req.revalidate !== false) {
      const existingInvoices = Array.from(this.documentStore.values())
        .filter(d => d.id !== doc.id && d.extraction)
        .map(d => d.extraction!);

      validation = ValidationService.validateInvoice(extraction, existingInvoices);
      status = validation.status === 'valid' ? 'completed' : validation.status;
    }

    const correctedDocument: DocumentRecord = {
      ...doc,
      extraction,
      validation,
      status,
      updatedAt: now,
      auditTrail: [...doc.auditTrail, ...auditEntries],
    };
    this.repository.saveCorrection(correctedDocument, auditEntries);
    this.documentStore.set(doc.id, correctedDocument);

    return {
      success: true,
      documentId: doc.id,
      status: correctedDocument.status,
      updatedFields,
      auditTrail: correctedDocument.auditTrail,
      validationStatus: correctedDocument.status,
    };
  }

  /**
   * POST /api/v1/documents/:document_id/retry
   */
  public retryJob(documentId: string): RetryResponse {
    const doc = this.documentStore.get(documentId);
    if (!doc) {
      throw new HttpError(404, 'DOCUMENT_NOT_FOUND', `Document with ID "${documentId}" was not found.`);
    }

    const result = this.jobQueue.retry(documentId);
    if (!result.success) {
      if (result.status === 'failed' && !doc.rawBuffer) {
        throw new HttpError(409, 'SOURCE_FILE_UNAVAILABLE', result.message);
      }
      throw new HttpError(409, 'CONCURRENT_RETRY_CONFLICT', result.message);
    }

    return {
      success: true,
      documentId: doc.id,
      status: result.status,
      message: result.message,
    };
  }

  /**
   * POST /api/v1/documents/cross-verify
   * Reconciles two documents (e.g. PDF Invoice vs Excel PO / Delivery Log).
   */
  public crossVerifyDocuments(sourceId: string, targetId: string): CrossVerificationResult {
    const docA = this.documentStore.get(sourceId);
    if (!docA) {
      throw new HttpError(404, 'DOCUMENT_NOT_FOUND', `Source document with ID "${sourceId}" was not found.`, 'sourceId');
    }
    const docB = this.documentStore.get(targetId);
    if (!docB) {
      throw new HttpError(404, 'DOCUMENT_NOT_FOUND', `Target document with ID "${targetId}" was not found.`, 'targetId');
    }

    if (!docA.extraction) {
      throw new HttpError(400, 'NO_EXTRACTION_DATA', `Source document "${sourceId}" has not completed extraction yet.`);
    }
    if (!docB.extraction) {
      throw new HttpError(400, 'NO_EXTRACTION_DATA', `Target document "${targetId}" has not completed extraction yet.`);
    }

    return CrossVerificationService.crossVerify(docA.extraction, docB.extraction, {
      sourceId,
      targetId,
    });
  }

  /**
   * GET /api/v1/documents/search/semantic
   * Executes genuine vector semantic search over stored documents.
   */
  public async semanticSearchDocuments(query: string, minSimilarity = 0.2): Promise<SemanticSearchResponse> {
    if (!query || !query.trim()) {
      throw new HttpError(400, 'EMPTY_QUERY', 'Search query parameter cannot be empty.', 'q');
    }
    if (!Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) {
      throw new HttpError(400, 'INVALID_MIN_SIMILARITY', 'min_similarity must be a number between 0 and 1.', 'min_similarity');
    }

    const allDocs = Array.from(this.documentStore.values());
    return await semanticSearchService.search(query, allDocs, minSimilarity);
  }

  /**
   * GET /health
   */
  public getHealth(): HealthResponse {
    const queueStatus = this.jobQueue.getStatusMetrics();
    let databaseStatus: 'connected' | 'disconnected' = 'connected';
    try {
      this.repository.checkConnection();
    } catch (error) {
      databaseStatus = 'disconnected';
      console.error('Health check could not reach the document database:', error);
    }
    return {
      status: databaseStatus === 'connected' ? 'ok' : 'degraded',
      version: '1.0.0',
      service: 'DocuPulse Backend REST API',
      environment: 'local_assessment_demo',
      databaseStatus,
      queueStatus,
      authWarning: 'Local assessment demo - authentication disabled. Not suitable for public deployment without RBAC/OAuth.',
    };
  }
}

export class HttpError extends Error {
  public statusCode: number;
  public errorCode: string;
  public field?: string;

  constructor(statusCode: number, errorCode: string, message: string, field?: string) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.field = field;
  }
}

export const documentController = new DocumentController();
