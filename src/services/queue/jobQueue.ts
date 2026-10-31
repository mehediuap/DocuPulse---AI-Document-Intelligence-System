/**
 * SQLite-backed background queue with expiring worker leases.
 * Job payloads remain on disk and are loaded only after a worker claims a job.
 */

import { randomUUID } from 'node:crypto';
import { DocumentRecord, JobStatus } from '../api/types.ts';
import { documentPipeline } from '../document/documentPipeline.ts';
import { DocumentSourceStorage, documentSourceStorage } from '../document/sourceStorage.ts';
import { ExtractionFactory } from '../extraction/llmAdapter.ts';
import { ValidationService } from '../validation/validationService.ts';
import { DocumentRepository, documentRepository } from '../../db/repository.ts';

const LEASE_DURATION_MS = 120_000;
const POLL_INTERVAL_MS = 500;

export class BackgroundJobQueue {
  private readonly workerId = `worker-${randomUUID()}`;
  private readonly activeJobs = new Set<string>();
  private readonly maxConcurrency = 3;
  private readonly repository: DocumentRepository;
  private readonly sourceStorage: DocumentSourceStorage;
  private pollTimer: NodeJS.Timeout | undefined;

  constructor(
    repository: DocumentRepository = documentRepository,
    sourceStorage: DocumentSourceStorage = documentSourceStorage
  ) {
    this.repository = repository;
    this.sourceStorage = sourceStorage;
    this.schedulePoll(0);
  }

  public enqueue(documentId: string): void {
    if (!this.repository.getDocument(documentId)) {
      throw new Error(`Cannot enqueue unknown document "${documentId}".`);
    }
    this.schedulePoll(0);
  }

  public retry(documentId: string): { success: boolean; message: string; status: JobStatus } {
    const doc = this.repository.getDocument(documentId);
    if (!doc) {
      return { success: false, message: 'Document not found.', status: 'failed' };
    }

    if (this.activeJobs.has(documentId) || this.repository.getProcessingJobStatus(documentId) === 'processing') {
      return {
        success: false,
        message: 'Job is already currently being processed. Concurrent duplicate retry rejected.',
        status: 'processing',
      };
    }

    if (!doc.storagePath || !this.sourceStorage.read(doc.storagePath)) {
      doc.status = 'failed';
      const sourceError = 'Original source file is unavailable; this job cannot be retried.';
      if (doc.errors[doc.errors.length - 1] !== sourceError) doc.errors.push(sourceError);
      doc.updatedAt = new Date().toISOString();
      this.repository.saveJobState(doc, doc.retryCount + 1, 'failed', 0, sourceError);
      return { success: false, message: sourceError, status: 'failed' };
    }

    doc.retryCount += 1;
    doc.status = 'queued';
    doc.updatedAt = new Date().toISOString();
    doc.errors = [];
    doc.warnings = [];
    this.repository.saveJobState(doc, doc.retryCount + 1, 'queued');
    this.schedulePoll(0);

    return {
      success: true,
      message: `Document ${documentId} successfully requeued (attempt #${doc.retryCount}).`,
      status: 'queued',
    };
  }

  private schedulePoll(delay = POLL_INTERVAL_MS): void {
    if (this.pollTimer) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.poll().catch(error => {
        console.error('Persistent job queue polling failed:', error);
        this.schedulePoll();
      });
    }, delay);
    this.pollTimer.unref?.();
  }

  private async poll(): Promise<void> {
    while (this.activeJobs.size < this.maxConcurrency) {
      const claim = this.repository.claimNextQueuedJob(this.workerId, LEASE_DURATION_MS);
      if (!claim) break;
      this.activeJobs.add(claim.documentId);
      void this.processJob(claim.documentId, claim.attemptNumber)
        .catch(error => {
          console.error(`Queue worker failed outside document handling for ${claim.documentId}:`, error);
        })
        .finally(() => {
          this.activeJobs.delete(claim.documentId);
          this.schedulePoll(0);
        });
    }
    this.schedulePoll();
  }

  private async processJob(documentId: string, attemptNumber: number): Promise<void> {
    const doc = this.repository.getDocument(documentId);
    if (!doc) {
      console.error(`Claimed queue job ${documentId} has no corresponding document row.`);
      return;
    }

    const rawBuffer = doc.storagePath ? this.sourceStorage.read(doc.storagePath) : undefined;
    if (!rawBuffer) {
      doc.status = 'failed';
      doc.errors.push('Original source file is unavailable; processing cannot start.');
      doc.updatedAt = new Date().toISOString();
      this.repository.finishClaimedJob(
        doc, attemptNumber, this.workerId, 'failed', 0, doc.errors[doc.errors.length - 1]
      );
      return;
    }

    let leaseLost = false;
    const heartbeat = setInterval(() => {
      try {
        if (!this.repository.renewProcessingLease(documentId, this.workerId, LEASE_DURATION_MS)) {
          leaseLost = true;
          clearInterval(heartbeat);
          console.error(`Worker lease for document ${documentId} was lost.`);
        }
      } catch (error) {
        leaseLost = true;
        clearInterval(heartbeat);
        console.error(`Could not renew worker lease for document ${documentId}:`, error);
      }
    }, Math.floor(LEASE_DURATION_MS / 3));
    heartbeat.unref?.();

    const startTime = performance.now();
    doc.rawBuffer = rawBuffer;
    doc.status = 'processing';
    doc.updatedAt = new Date().toISOString();

    try {
      this.repository.saveDocument(doc);
      const parsed = await documentPipeline.processSingleFile({
        name: doc.sanitizedFilename,
        size: doc.fileSizeBytes,
        type: doc.mimeType,
        data: rawBuffer,
      });

      doc.rawText = parsed.rawText;
      doc.warnings.push(...parsed.warnings);
      doc.errors.push(...parsed.errors);

      if (parsed.status === 'failed') {
        doc.status = 'failed';
        doc.processingDurationMs = Math.round(performance.now() - startTime);
        doc.updatedAt = new Date().toISOString();
      } else {
        const extraction = await ExtractionFactory.createAdapter().extract(doc.rawText || '');
        doc.extraction = extraction;

        const ocrPages = parsed.pages?.filter(page => page.isOcr) || [];
        if (ocrPages.length > 0) {
          const calibratedConfidences = ocrPages
            .map(page => page.confidence)
            .filter((confidence): confidence is number => typeof confidence === 'number');
          const ocrConfidence = calibratedConfidences.length > 0
            ? Math.min(...calibratedConfidences)
            : null;
          for (const evidence of Object.values(extraction.evidence || {})) {
            evidence.confidence = ocrConfidence === null
              ? 0
              : Math.min(evidence.confidence, ocrConfidence);
          }
          if (ocrConfidence === null) {
            extraction.extraction_metadata.warnings.push(
              'OCR provider did not return calibrated confidence; extracted fields require manual review.'
            );
          }
        }

        doc.warnings.push(...extraction.extraction_metadata.warnings);
        const historicalInvoices = this.repository.getInvoiceExtractionsExcept(doc.id);
        doc.validation = ValidationService.validateInvoice(extraction, historicalInvoices);
        doc.status = doc.validation.status === 'valid' ? 'completed' : doc.validation.status;
        doc.processingDurationMs = Math.round(performance.now() - startTime);
        doc.updatedAt = new Date().toISOString();
      }
    } catch (workerError) {
      const message = workerError instanceof Error ? workerError.message : String(workerError);
      doc.status = 'failed';
      doc.errors.push(`Internal worker failure: ${message}`);
      doc.processingDurationMs = Math.round(performance.now() - startTime);
      doc.updatedAt = new Date().toISOString();
    } finally {
      clearInterval(heartbeat);
      doc.rawBuffer = undefined;
    }

    if (leaseLost) return;
    const completed = this.repository.finishClaimedJob(
      doc,
      attemptNumber,
      this.workerId,
      doc.status,
      doc.processingDurationMs,
      doc.status === 'failed' ? doc.errors.join('; ') : undefined
    );
    if (!completed) {
      console.error(`Worker ${this.workerId} could not commit document ${documentId}; its lease is no longer valid.`);
    }
  }

  public getStatusMetrics(): {
    queued: number;
    processing: number;
    completed: number;
    needs_review: number;
    invalid: number;
    failed: number;
    total: number;
  } {
    const counts = this.repository.getDocumentStatusCounts();
    return {
      queued: counts.queued || 0,
      processing: counts.processing || 0,
      completed: counts.completed || 0,
      needs_review: counts.needs_review || 0,
      invalid: counts.invalid || 0,
      failed: counts.failed || 0,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    };
  }
}
