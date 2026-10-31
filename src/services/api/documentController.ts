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
import { SemanticSearchService, SemanticSearchResponse } from '../search/semanticSearch.ts';
import { getApiAuthenticationWarning } from './authentication.ts';
import { documentRepository, DocumentRepository } from '../../db/repository.ts';
import {
  DocumentSourceStorage,
  MemoryDocumentSourceStorage,
  documentSourceStorage,
} from '../document/sourceStorage.ts';
import { InvoiceExtractionResult } from '../extraction/schemas.ts';
import { roundToTwoDecimals } from '../validation/decimalUtils.ts';
import { closeSync, openSync, readSync } from 'node:fs';

export interface DiskUploadFile {
  originalName: string;
  size: number;
  type?: string;
  path: string;
}

interface ValidatedUpload {
  name: string;
  size: number;
  type?: string;
  sanitizedName: string;
  fileType: string;
  save: (documentId: string) => string;
}

export class DocumentController {
  private jobQueue: BackgroundJobQueue;
  private repository: DocumentRepository;
  private semanticSearch: SemanticSearchService;
  private sourceStorage: DocumentSourceStorage;

  constructor(customRepo?: DocumentRepository, customStorage?: DocumentSourceStorage) {
    this.repository = customRepo || documentRepository;
    this.semanticSearch = new SemanticSearchService(this.repository);
    this.sourceStorage = customStorage || (customRepo ? new MemoryDocumentSourceStorage() : documentSourceStorage);
    this.jobQueue = new BackgroundJobQueue(this.repository, this.sourceStorage);
  }

  public getRepository(): DocumentRepository {
    return this.repository;
  }

  public getQueue(): BackgroundJobQueue {
    return this.jobQueue;
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
      return this.validateUpload(
        file.name,
        file.size,
        file.type,
        file.buffer.slice(0, 16),
        documentId => this.sourceStorage.save(documentId, new Uint8Array(file.buffer))
      );
    });

    return this.enqueueValidatedUploads(validatedFiles);
  }

  public async uploadDocumentsFromDisk(files: DiskUploadFile[]): Promise<DocumentUploadResponse> {
    if (!files || files.length === 0) {
      throw new HttpError(400, 'NO_FILES_PROVIDED', 'At least one file must be uploaded.');
    }

    const validatedFiles = files.map(file => {
      let descriptor: number | undefined;
      const header = Buffer.alloc(16);
      let headerLength = 0;
      try {
        descriptor = openSync(file.path, 'r');
        headerLength = readSync(descriptor, header, 0, header.length, 0);
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }

      return this.validateUpload(
        file.originalName,
        file.size,
        file.type,
        header.subarray(0, headerLength),
        documentId => this.sourceStorage.saveFromFile(documentId, file.path)
      );
    });

    return this.enqueueValidatedUploads(validatedFiles);
  }

  private validateUpload(
    name: string,
    size: number,
    type: string | undefined,
    headerBytes: Uint8Array,
    save: (documentId: string) => string
  ): ValidatedUpload {
    const sanitizedName = sanitizeFilename(name);
    const bounds = validateFileBounds(size);
    if (!bounds.valid) {
      throw new HttpError(400, 'INVALID_FILE_BOUNDS', bounds.error || 'File bounds invalid.', 'size');
    }

    const fileType = detectFileType(sanitizedName, headerBytes);
    if (fileType === 'unsupported') {
      throw new HttpError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        `Format not supported for file "${name}". Supported: PDF, JPG, PNG, TIFF, XLSX, XLS, CSV.`,
        'file'
      );
    }

    return { name, size, type, sanitizedName, fileType, save };
  }

  private enqueueValidatedUploads(validatedFiles: ValidatedUpload[]): DocumentUploadResponse {
    const items: DocumentUploadResponse['documents'] = [];

    for (const { name, size, type, sanitizedName, fileType, save } of validatedFiles) {
      const docId = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const now = new Date().toISOString();
      const storagePath = save(docId);

      const record: DocumentRecord = {
        id: docId,
        originalFilename: name,
        sanitizedFilename: sanitizedName,
        fileType,
        mimeType: type || 'application/octet-stream',
        fileSizeBytes: size,
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
    const doc = this.repository.getDocument(documentId);
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
    const doc = this.repository.getDocument(documentId);
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
    req: CorrectionRequest,
    actorId = 'local-development-user'
  ): CorrectionResponse {
    const doc = this.repository.getDocument(documentId);
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
        author: actorId,
      };
      auditEntries.push(auditEntry);
      updatedFields.push(field);
    }

    let validation = doc.validation;
    let status = doc.status;
    if (req.revalidate !== false) {
      const existingInvoices = this.repository.getInvoiceExtractionsExcept(doc.id);

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
    const doc = this.repository.getDocument(documentId);
    if (!doc) {
      throw new HttpError(404, 'DOCUMENT_NOT_FOUND', `Document with ID "${documentId}" was not found.`);
    }

    const result = this.jobQueue.retry(documentId);
    if (!result.success) {
      if (result.status === 'failed' && result.message.includes('source file is unavailable')) {
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
    const docA = this.repository.getDocument(sourceId);
    if (!docA) {
      throw new HttpError(404, 'DOCUMENT_NOT_FOUND', `Source document with ID "${sourceId}" was not found.`, 'sourceId');
    }
    const docB = this.repository.getDocument(targetId);
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

    const allDocs = this.repository.getAllDocuments();
    return await this.semanticSearch.search(query, allDocs, minSimilarity);
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
      environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
      databaseStatus,
      queueStatus,
      authWarning: getApiAuthenticationWarning(),
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
