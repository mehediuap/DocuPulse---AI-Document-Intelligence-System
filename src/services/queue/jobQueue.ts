/**
 * Documented Local Background Job Queue Abstraction
 * Manages asynchronous document parsing, OCR, LLM extraction, and validation.
 * 
 * Architecture & Concurrency Rules:
 * - Decouples HTTP upload response from long-running document processing.
 * - Enforces status lifecycle: queued -> processing -> completed / needs_review / invalid / failed.
 * - Employs a concurrency lock (isProcessing) per document to reject duplicate simultaneous retries.
 * - Can be swapped with Redis / Celery in enterprise production clusters.
 */

import { DocumentRecord, JobStatus } from '../api/types.ts';
import { documentPipeline } from '../document/documentPipeline.ts';
import { ExtractionFactory } from '../extraction/llmAdapter.ts';
import { ValidationService } from '../validation/validationService.ts';
import { DocumentRepository, documentRepository } from '../../db/repository.ts';

export type JobHandler = (doc: DocumentRecord) => Promise<void>;

export class BackgroundJobQueue {
  private queue: string[] = [];
  private activeJobs = new Set<string>();
  private maxConcurrency = 3;
  private documentStore: Map<string, DocumentRecord>;
  private repository: DocumentRepository;
  private isDraining = false;

  constructor(store: Map<string, DocumentRecord>, repository: DocumentRepository = documentRepository) {
    this.documentStore = store;
    this.repository = repository;
  }

  /**
   * Enqueues a document for background parsing, extraction, and validation.
   */
  public enqueue(documentId: string): void {
    const doc = this.documentStore.get(documentId);
    if (!doc) return;

    if (doc.status !== 'queued') {
      doc.status = 'queued';
      doc.updatedAt = new Date().toISOString();
      this.repository.saveDocument(doc);
    }

    if (!this.queue.includes(documentId) && !this.activeJobs.has(documentId)) {
      this.queue.push(documentId);
    }

    this.drain();
  }

  /**
   * Safely retries a document processing job with concurrency protection.
   */
  public retry(documentId: string): { success: boolean; message: string; status: JobStatus } {
    const doc = this.documentStore.get(documentId);
    if (!doc) {
      return { success: false, message: 'Document not found.', status: 'failed' };
    }

    // Guard against duplicate concurrent retries
    if (this.activeJobs.has(documentId) || doc.status === 'processing') {
      return {
        success: false,
        message: 'Job is already currently being processed. Concurrent duplicate retry rejected.',
        status: doc.status,
      };
    }

    if (!doc.rawBuffer) {
      doc.status = 'failed';
      const sourceError = 'Original source file is unavailable; this job cannot be retried.';
      if (doc.errors[doc.errors.length - 1] !== sourceError) doc.errors.push(sourceError);
      doc.updatedAt = new Date().toISOString();
      this.repository.saveDocument(doc);
      return {
        success: false,
        message: 'Original source file is unavailable; this job cannot be retried.',
        status: 'failed',
      };
    }

    doc.retryCount += 1;
    doc.status = 'queued';
    doc.updatedAt = new Date().toISOString();
    doc.errors = [];
    doc.warnings = [];
    this.repository.saveJobState(doc, doc.retryCount + 1, 'queued');

    this.queue.push(documentId);
    this.drain();

    return {
      success: true,
      message: `Document ${documentId} successfully requeued (attempt #${doc.retryCount}).`,
      status: 'queued',
    };
  }

  /**
   * Drains the queue respecting concurrency limits.
   */
  private async drain(): Promise<void> {
    if (this.isDraining) return;
    this.isDraining = true;

    while (this.queue.length > 0 && this.activeJobs.size < this.maxConcurrency) {
      const docId = this.queue.shift();
      if (!docId) continue;

      this.activeJobs.add(docId);
      // Run worker without awaiting to maintain asynchronous queue processing
      this.processJob(docId).catch(error => {
        console.error(`Queue worker failed outside document handling for ${docId}:`, error);
      }).finally(() => {
        this.activeJobs.delete(docId);
        this.drain();
      });
    }

    this.isDraining = false;
  }

  /**
   * Worker task: Executes Module 1 parsing, Module 2 extraction, and Module 3 validation.
   */
  private async processJob(documentId: string): Promise<void> {
    const doc = this.documentStore.get(documentId);
    if (!doc || !doc.rawBuffer) {
      if (doc) {
        doc.status = 'failed';
        doc.errors.push('Original source file is unavailable; processing cannot start.');
        doc.updatedAt = new Date().toISOString();
        this.repository.saveJobState(doc, doc.retryCount + 1, 'failed', 0, doc.errors.at(-1));
      }
      return;
    }

    const startTime = performance.now();
    doc.status = 'processing';
    doc.updatedAt = new Date().toISOString();
    const attemptNumber = doc.retryCount + 1;

    try {
      this.repository.saveJobState(doc, attemptNumber, 'processing');
      // 1. Task 1: Document Processing Pipeline
      const parsed = await documentPipeline.processSingleFile({
        name: doc.sanitizedFilename,
        size: doc.fileSizeBytes,
        type: doc.mimeType,
        data: doc.rawBuffer,
      });

      doc.rawText = parsed.rawText;
      doc.warnings.push(...parsed.warnings);
      if (parsed.errors.length > 0) {
        doc.errors.push(...parsed.errors);
      }

      if (parsed.status === 'failed') {
        doc.status = 'failed';
        doc.processingDurationMs = Math.round(performance.now() - startTime);
        doc.updatedAt = new Date().toISOString();
        this.repository.saveJobState(
          doc,
          attemptNumber,
          'failed',
          doc.processingDurationMs,
          doc.errors.join('; ')
        );
        return;
      }

      // 2. Task 2: AI Information Extraction
      const adapter = ExtractionFactory.createAdapter();
      const extraction = await adapter.extract(doc.rawText || '');
      doc.extraction = extraction;

      if (extraction.extraction_metadata?.warnings) {
        doc.warnings.push(...extraction.extraction_metadata.warnings);
      }

      // 3. Task 3: Data Validation & Reconciliation
      // Compare against other completed invoices in the store for duplicate detection
      const existingInvoices = Array.from(this.documentStore.values())
        .filter(d => d.id !== doc.id && d.extraction)
        .map(d => d.extraction!);

      const validation = ValidationService.validateInvoice(extraction, existingInvoices);
      doc.validation = validation;

      doc.status = validation.status === 'valid' ? 'completed' : validation.status;

      doc.processingDurationMs = Math.round(performance.now() - startTime);
      doc.updatedAt = new Date().toISOString();

      // Persist the validation-derived document status to SQLite.
      this.repository.saveJobState(
        doc,
        attemptNumber,
        doc.status,
        doc.processingDurationMs
      );
    } catch (workerErr) {
      const msg = workerErr instanceof Error ? workerErr.message : String(workerErr);
      doc.status = 'failed';
      doc.errors.push(`Internal worker failure: ${msg}`);
      doc.processingDurationMs = Math.round(performance.now() - startTime);
      doc.updatedAt = new Date().toISOString();

      // Persist failure state to SQLite database
      this.repository.saveJobState(
        doc,
        attemptNumber,
        'failed',
        doc.processingDurationMs,
        msg
      );
    }
  }

  /**
   * Returns current queue state metrics.
   */
  public getStatusMetrics(): {
    queued: number;
    processing: number;
    completed: number;
    needs_review: number;
    invalid: number;
    failed: number;
    total: number;
  } {
    let queued = 0;
    let processing = 0;
    let completed = 0;
    let needs_review = 0;
    let invalid = 0;
    let failed = 0;

    for (const doc of this.documentStore.values()) {
      switch (doc.status) {
        case 'queued': queued++; break;
        case 'processing': processing++; break;
        case 'completed': completed++; break;
        case 'needs_review': needs_review++; break;
        case 'invalid': invalid++; break;
        case 'failed': failed++; break;
      }
    }

    return {
      queued,
      processing,
      completed,
      needs_review,
      invalid,
      failed,
      total: this.documentStore.size,
    };
  }
}
