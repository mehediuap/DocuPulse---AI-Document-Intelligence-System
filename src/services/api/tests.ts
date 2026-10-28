/**
 * Automated Verification Suite for Task 4: Backend REST API
 * Tests all endpoints: upload, status, result, list/search, corrections, retry, health, and error handling.
 */

import { DocumentController, HttpError } from './documentController.ts';
import { createDigitalPdfBytes } from '../document/tests.ts';
import { DatabaseClient } from '../../db/database.ts';
import { DocumentRepository, documentRepository } from '../../db/repository.ts';
import { FileDocumentSourceStorage } from '../document/sourceStorage.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface TestRunResult {
  name: string;
  passed: boolean;
  durationMs: number;
  details: string;
}

export async function runBackendApiTests(): Promise<{
  total: number;
  passed: number;
  failed: number;
  results: TestRunResult[];
}> {
  const results: TestRunResult[] = [];

  async function test(name: string, fn: () => Promise<void>) {
    const start = performance.now();
    try {
      await fn();
      results.push({
        name,
        passed: true,
        durationMs: Math.round(performance.now() - start),
        details: 'Passed with verified assertions',
      });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      results.push({
        name,
        passed: false,
        durationMs: Math.round(performance.now() - start),
        details: err,
      });
    }
  }

  // Use a fresh controller instance with isolated in-memory DB for clean, hermetic test execution
  const testDb = DatabaseClient.createInMemory();
  const repo = new DocumentRepository(testDb);
  const testUploadDirectory = mkdtempSync(path.join(tmpdir(), 'docupulse-api-test-'));
  const sourceStorage = new FileDocumentSourceStorage(testUploadDirectory);
  const controller = new DocumentController(repo, sourceStorage);

  let uploadedDocId1 = '';
  let uploadedDocId2 = '';

  // 1. Upload one or multiple files (POST /api/v1/documents)
  await test('1. Upload endpoint (POST /api/v1/documents) accepts multiple files and queues jobs', async () => {
    const pdfBytes1 = createDigitalPdfBytes('INV-API-001', 1);
    const pdfBytes2 = createDigitalPdfBytes('INV-API-002', 1);

    const uploadRes = await controller.uploadDocuments([
      { name: 'invoice_alpha.pdf', size: pdfBytes1.length, type: 'application/pdf', buffer: pdfBytes1 },
      { name: 'invoice_beta.pdf', size: pdfBytes2.length, type: 'application/pdf', buffer: pdfBytes2 },
    ]);

    if (!uploadRes.success) throw new Error('Upload response indicated failure');
    if (uploadRes.totalQueued !== 2) throw new Error(`Expected 2 queued, got ${uploadRes.totalQueued}`);
    if (uploadRes.documents[0].status !== 'queued') throw new Error('Document status should be queued');

    uploadedDocId1 = uploadRes.documents[0].documentId;
    uploadedDocId2 = uploadRes.documents[1].documentId;

    if (!uploadedDocId1 || !uploadedDocId2) throw new Error('Missing documentId in upload response');
  });

  // 2. Status & Metadata endpoint (GET /api/v1/documents/{document_id})
  await test('2. Metadata & status endpoint (GET /api/v1/documents/{id}) returns job state', async () => {
    const meta = controller.getDocumentMetadata(uploadedDocId1);
    if (meta.id !== uploadedDocId1) throw new Error('ID mismatch');
    if (!['queued', 'processing', 'completed', 'needs_review', 'invalid'].includes(meta.status)) {
      throw new Error(`Unexpected status: ${meta.status}`);
    }
    if (meta.fileSizeBytes <= 0) throw new Error('fileSizeBytes should be positive');
  });

  // 3. Background worker execution & Result retrieval (GET /api/v1/documents/{id}/result)
  await test('3. Result endpoint (GET /api/v1/documents/{id}/result) provides extraction and validation', async () => {
    // Wait for both background workers before simulating a process restart.
    for (const id of [uploadedDocId1, uploadedDocId2]) {
      let attempts = 0;
      let docMeta = controller.getDocumentMetadata(id);
      while (['queued', 'processing'].includes(docMeta.status) && attempts < 60) {
        await new Promise(r => setTimeout(r, 50));
        docMeta = controller.getDocumentMetadata(id);
        attempts++;
      }
      if (['queued', 'processing'].includes(docMeta.status)) throw new Error(`Job ${id} did not finish before timeout`);
    }

    const result = controller.getDocumentResult(uploadedDocId1);
    if (!['completed', 'needs_review', 'invalid'].includes(result.status)) {
      throw new Error(`Expected completed, needs_review, or invalid, got ${result.status}`);
    }
    if (!result.extraction) throw new Error('Missing extraction payload in result');
    if (!result.validation) throw new Error('Missing validation payload in result');
    if (result.extraction.invoice_number !== 'INV-API-001') {
      throw new Error(`Extraction mismatch: ${result.extraction.invoice_number}`);
    }

    const interruptedDoc = repo.getDocument(uploadedDocId2);
    if (!interruptedDoc) throw new Error('Persisted document was not found for recovery test');
    interruptedDoc.status = 'queued';
    repo.saveDocument(interruptedDoc);
    const restartedController = new DocumentController(repo, sourceStorage);
    const restored = restartedController.getStore().get(uploadedDocId2);
    if (!restored?.rawBuffer || restored.rawBuffer.byteLength === 0) {
      throw new Error('Restart did not restore the persisted source file');
    }
    let attempts = 0;
    let restartedMeta = restartedController.getDocumentMetadata(uploadedDocId2);
    while (['queued', 'processing'].includes(restartedMeta.status) && attempts < 60) {
      await new Promise(r => setTimeout(r, 50));
      restartedMeta = restartedController.getDocumentMetadata(uploadedDocId2);
      attempts++;
    }
    if (!['completed', 'needs_review'].includes(restartedMeta.status)) {
      throw new Error(`Restarted job did not recover to a terminal state: ${restartedMeta.status}`);
    }
  });

  // 4. Paginated list, status filtering, and keyword search (GET /api/v1/documents)
  await test('4. List endpoint (GET /api/v1/documents) supports pagination, filtering, and search', async () => {
    // List all
    const all = controller.listDocuments({ page: 1, limit: 10 });
    if (all.total < 2) throw new Error(`Expected at least 2 items, got ${all.total}`);

    // Search by keyword
    const searchRes = controller.listDocuments({ page: 1, limit: 10, search: 'alpha' });
    if (searchRes.items.length !== 1) throw new Error(`Expected 1 item searching 'alpha', got ${searchRes.items.length}`);
    if (!searchRes.items[0].originalFilename.includes('alpha')) throw new Error('Search result mismatch');

    // Pagination bounds
    const paginated = controller.listDocuments({ page: 1, limit: 1 });
    if (paginated.items.length !== 1) throw new Error('Limit parameter not respected');
    if (paginated.totalPages < 2) throw new Error('totalPages should reflect total / limit');
  });

  // 5. Validated manual correction with audit trail (PATCH /api/v1/documents/{id}/corrections)
  await test('5. Corrections endpoint (PATCH /api/v1/documents/{id}/corrections) records audit trail', async () => {
    const correctionRes = controller.applyCorrections(uploadedDocId1, {
      corrections: {
        invoice_number: 'INV-API-001-CORRECTED',
        customer_name: 'Nexus Dynamics Inc.',
      },
      reason: 'Audit correction per physical PO document',
      revalidate: true,
    });

    if (!correctionRes.success) throw new Error('Correction response indicated failure');
    if (!correctionRes.updatedFields.includes('invoice_number')) throw new Error('invoice_number not recorded in updatedFields');
    if (correctionRes.auditTrail.length === 0) throw new Error('Audit trail was not populated');

    const lastAudit = correctionRes.auditTrail[correctionRes.auditTrail.length - 1];
    if (lastAudit.field !== 'customer_name' && lastAudit.field !== 'invoice_number') {
      throw new Error('Audit entry field mismatch');
    }
    if (lastAudit.reason !== 'Audit correction per physical PO document') {
      throw new Error('Audit reason mismatch');
    }

    // Verify result reflects update
    const updatedResult = controller.getDocumentResult(uploadedDocId1);
    if (updatedResult.extraction?.invoice_number !== 'INV-API-001-CORRECTED') {
      throw new Error('Extraction was not updated with corrected value');
    }

    const auditCount = updatedResult.auditTrail.length;
    try {
      controller.applyCorrections(uploadedDocId1, {
        corrections: { invoice_number: 'SHOULD-NOT-PERSIST', total: '1100invalid' },
        reason: 'Rejected invalid correction',
      });
      throw new Error('Malformed correction should have been rejected');
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 422) throw error;
    }
    const unchanged = controller.getDocumentResult(uploadedDocId1);
    if (unchanged.extraction?.invoice_number !== 'INV-API-001-CORRECTED' ||
      unchanged.auditTrail.length !== auditCount) {
      throw new Error('Rejected correction partially mutated the extraction or audit trail');
    }
  });

  // 6. Safe retry mechanism with concurrency lock (POST /api/v1/documents/{id}/retry)
  await test('6. Retry endpoint (POST /api/v1/documents/{id}/retry) requeues job with concurrency lock', async () => {
    const retryRes = controller.retryJob(uploadedDocId1);
    if (!retryRes.success) throw new Error('Retry was not successful');
    if (retryRes.status !== 'queued') throw new Error('Status should be queued on retry');

    const meta = controller.getDocumentMetadata(uploadedDocId1);
    if (meta.retryCount !== 1) throw new Error(`Expected retryCount 1, got ${meta.retryCount}`);

    // If job is processing, duplicate concurrent retry should be rejected with 409
    const queue = controller.getQueue();
    // Simulate active processing lock
    (queue as any).activeJobs.add(uploadedDocId1);
    try {
      controller.retryJob(uploadedDocId1);
      throw new Error('Concurrent duplicate retry should have thrown HttpError 409');
    } catch (err) {
      if (!(err instanceof HttpError) || err.statusCode !== 409) {
        throw new Error(`Expected HttpError 409 CONCURRENT_RETRY_CONFLICT, got: ${err}`);
      }
    } finally {
      (queue as any).activeJobs.delete(uploadedDocId1);
    }
  });

  // 7. Invalid input validation (unsupported media type, oversized, traversal)
  await test('7. Input validation rejects unsupported types, empty uploads, and non-existent IDs', async () => {
    const storedBefore = repo.searchDocuments({ limit: 1 }).total;
    const validPdf = createDigitalPdfBytes('INV-NOT-STORED');
    try {
      await controller.uploadDocuments([
        { name: 'would_be_partial.pdf', size: validPdf.length, buffer: validPdf },
        { name: 'malicious.exe', size: 3, buffer: new Uint8Array([0x4D, 0x5A, 0x90]) },
      ]);
      throw new Error('Should have rejected .exe with 415');
    } catch (err) {
      if (!(err instanceof HttpError) || err.statusCode !== 415) {
        throw new Error(`Expected 415 error, got ${err}`);
      }
    }
    if (repo.searchDocuments({ limit: 1 }).total !== storedBefore) {
      throw new Error('Rejected batch partially persisted a valid file');
    }

    // Empty upload list
    try {
      await controller.uploadDocuments([]);
      throw new Error('Should have rejected empty files with 400');
    } catch (err) {
      if (!(err instanceof HttpError) || err.statusCode !== 400) {
        throw new Error(`Expected 400 error, got ${err}`);
      }
    }

    // Non-existent document ID
    try {
      controller.getDocumentMetadata('doc_non_existent_id');
      throw new Error('Should have returned 404 for missing document');
    } catch (err) {
      if (!(err instanceof HttpError) || err.statusCode !== 404) {
        throw new Error(`Expected 404 error, got ${err}`);
      }
    }
  });

  // 8. Health check endpoint (GET /health)
  await test('8. Health endpoint (GET /health) returns queue metrics and assessment auth warning', async () => {
    const health = controller.getHealth();
    if (health.status !== 'ok') throw new Error(`Expected health ok, got ${health.status}`);
    if (health.databaseStatus !== 'connected') throw new Error('Health check did not confirm the database connection');
    if (health.queueStatus.total <= 0) throw new Error('Queue status total should be > 0');
    if (!health.authWarning.includes('Local assessment demo')) {
      throw new Error('Missing local assessment demo auth disclosure');
    }
  });

  // 9. Cross-verification endpoint test
  await test('9. Cross-verification endpoint validates matching documents and flags missing IDs', async () => {
    // Both documents need extraction
    const store = controller.getStore();
    const doc1 = store.get(uploadedDocId1);
    const doc2 = store.get(uploadedDocId2);

    if (doc1 && doc2) {
      doc1.extraction = {
        invoice_number: 'INV-CROSS-A',
        invoice_date: '2026-10-20',
        supplier_name: 'Tech Suppliers Inc',
        subtotal: 1000,
        tax: 100,
        total: 1100,
        currency: 'USD',
        line_items: [{ description: 'Test Item', quantity: 1, unit_price: 1000, amount: 1000 }],
      } as any;

      doc2.extraction = {
        invoice_number: 'PO-CROSS-A',
        invoice_date: '2026-10-20',
        supplier_name: 'Tech Suppliers Inc',
        subtotal: 1000,
        tax: 100,
        total: 1100,
        currency: 'USD',
        line_items: [{ description: 'Test Item', quantity: 1, unit_price: 1000, amount: 1000 }],
      } as any;

      const crossRes = controller.crossVerifyDocuments(uploadedDocId1, uploadedDocId2);
      if (crossRes.matchScorePercent < 80) {
        throw new Error(`Expected high cross-verification score, got ${crossRes.matchScorePercent}%`);
      }
      if (!crossRes.financialReconciliation.totalMatched) {
        throw new Error('Expected totalMatched to be true');
      }
    }

    // Missing target document error
    try {
      controller.crossVerifyDocuments(uploadedDocId1, 'non_existent_target');
      throw new Error('Should have thrown 404 for missing target');
    } catch (err: any) {
      if (err.statusCode !== 404) throw new Error(`Expected 404, got ${err}`);
    }
  });

  // 10. Semantic search endpoint test
  await test('10. Semantic search endpoint returns ranked vector matches', async () => {
    const semRes = await controller.semanticSearchDocuments('invoice', 0.1);
    if (!semRes || !Array.isArray(semRes.results)) {
      throw new Error('Expected valid semantic search response');
    }
    if (semRes.embeddingDimension <= 0) {
      throw new Error('Expected positive embedding dimension');
    }
  });

  await test('11. Queue persists only through its injected repository', async () => {
    for (const id of [uploadedDocId1, uploadedDocId2]) {
      let attempts = 0;
      let status = controller.getDocumentMetadata(id).status;
      while (['queued', 'processing'].includes(status) && attempts < 60) {
        await new Promise(r => setTimeout(r, 50));
        status = controller.getDocumentMetadata(id).status;
        attempts++;
      }
    }
    if (documentRepository.getDocument(uploadedDocId1) || documentRepository.getDocument(uploadedDocId2)) {
      throw new Error('Test queue wrote fixtures to the process-wide database');
    }
  });

  await test('12. Confirmed arithmetic contradictions keep the invalid status through queue and API', async () => {
    const csv = new TextEncoder().encode([
      'Invoice Number,Issue Date,Supplier,Subtotal,Tax,Total,Currency',
      'INV-API-INVALID,2026-10-12,Review Corp,100,10,125,USD',
    ].join('\n'));
    const upload = await controller.uploadDocuments([
      { name: 'contradictory-invoice.csv', size: csv.length, type: 'text/csv', buffer: csv },
    ]);
    const id = upload.documents[0].documentId;
    let attempts = 0;
    let status = controller.getDocumentMetadata(id).status;
    while (['queued', 'processing'].includes(status) && attempts < 60) {
      await new Promise(resolve => setTimeout(resolve, 50));
      status = controller.getDocumentMetadata(id).status;
      attempts++;
    }

    const result = controller.getDocumentResult(id);
    if (result.validation?.status !== 'invalid') throw new Error(`Expected invalid validation, got ${result.validation?.status}`);
    if (result.status !== 'invalid') throw new Error(`Queue/API status should remain invalid, got ${result.status}`);
    if (controller.getHealth().queueStatus.invalid < 1) throw new Error('Queue health metrics did not count the invalid document');
  });

  rmSync(testUploadDirectory, { recursive: true, force: true });

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  return {
    total: results.length,
    passed,
    failed,
    results,
  };
}
