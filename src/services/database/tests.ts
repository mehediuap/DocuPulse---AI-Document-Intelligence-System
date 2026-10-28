/**
 * Automated Verification Suite for Task 5: Database & Search
 * Tests persistence, schema migrations, decimal-safety, keyword search, multi-filtering,
 * duplicate candidate queries, processing history, audit trail, and semantic search fallback.
 */

import { DatabaseClient } from '../../db/database.ts';
import { DocumentRepository } from '../../db/repository.ts';
import { runMigrations } from '../../db/migrations.ts';
import { DocumentRecord } from '../api/types.ts';
import { semanticSearchService } from '../search/semanticSearch.ts';

export interface TestRunResult {
  name: string;
  passed: boolean;
  durationMs: number;
  details: string;
}

export async function runDatabaseAndSearchTests(): Promise<{
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

  // Create an isolated in-memory SQLite database instance for clean, hermetic tests
  const testDb = DatabaseClient.createInMemory();
  const repo = new DocumentRepository(testDb);

  // 1. Repeatable schema migrations
  await test('1. Schema initialization and repeatable migrations execute idempotently', async () => {
    // Run migrations second time on same database
    runMigrations(testDb);
    const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
    const tableNames = tables.map(t => t.name);

    if (!tableNames.includes('documents')) throw new Error('Missing documents table');
    if (!tableNames.includes('extractions')) throw new Error('Missing extractions table');
    if (!tableNames.includes('validations')) throw new Error('Missing validations table');
    if (!tableNames.includes('processing_history')) throw new Error('Missing processing_history table');
    if (!tableNames.includes('audit_trail')) throw new Error('Missing audit_trail table');
  });

  // 2. Full document persistence & retrieval
  await test('2. Full document persistence stores metadata, extraction, and validation', async () => {
    const docId = 'doc_test_persistence_01';
    const now = new Date().toISOString();

    const doc: DocumentRecord = {
      id: docId,
      originalFilename: 'q3_industrial_procurement.pdf',
      sanitizedFilename: 'q3_industrial_procurement.pdf',
      fileType: 'pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 204800,
      status: 'completed',
      createdAt: now,
      updatedAt: now,
      processingDurationMs: 450,
      retryCount: 0,
      rawText: 'Industrial Sensor Procurement Invoice for Apex Microelectronics Corp.',
      extraction: {
        invoice_number: 'INV-2026-8800',
        invoice_date: '2026-10-15',
        supplier_name: 'Apex Microelectronics Corp',
        customer_name: 'Starlight Robotics Inc',
        subtotal: 5000.00,
        tax: 400.00,
        total: 5400.00,
        currency: 'USD',
        line_items: [
          { description: 'Sensor Pack A', quantity: 5, unit_price: 1000.00, amount: 5000.00, evidence: 'Sensor Pack A', page_reference: 1 },
        ],
        evidence: { total: { snippet: 'Total: $5,400.00 USD', page_reference: 1, confidence: 0.99 } },
        extraction_metadata: { mode: 'mock_rule_based', processing_time_ms: 12, warnings: [] },
      },
      validation: {
        status: 'valid',
        totalIssues: 0,
        errorCount: 0,
        warningCount: 0,
        issues: [],
        errors: [],
        warnings: [],
        manualReviewRequired: false,
        reasonsForManualReview: [],
        reconciliation: {
          lineItemsCalculatedSum: 5000.00,
          statedSubtotal: 5000.00,
          subtotalDelta: 0,
          statedTax: 400.00,
          statedTotal: 5400.00,
          expectedTotal: 5400.00,
          totalDelta: 0,
          isReconciled: true,
          hasRoundingAdjustment: false,
        },
        validatedAt: now,
      },
      auditTrail: [],
      errors: [],
      warnings: [],
    };

    repo.saveDocument(doc);

    const retrieved = repo.getDocument(docId);
    if (!retrieved) throw new Error('Failed to retrieve persisted document');
    if (retrieved.sanitizedFilename !== 'q3_industrial_procurement.pdf') throw new Error('Filename mismatch');
    if (retrieved.extraction?.invoice_number !== 'INV-2026-8800') throw new Error('Extraction invoice_number mismatch');
    if (retrieved.validation?.status !== 'valid') throw new Error('Validation status mismatch');
  });

  // 3. Decimal-safe integer cents storage
  await test('3. Decimal-safe financial persistence stores exact integer cents without drift', async () => {
    const rawRow = testDb.prepare('SELECT subtotal_cents, tax_cents, total_cents FROM extractions WHERE document_id = ?').get('doc_test_persistence_01') as any;

    if (!rawRow) throw new Error('Failed to query raw extractions table');
    if (rawRow.subtotal_cents !== 500000) throw new Error(`Expected subtotal_cents 500000, got ${rawRow.subtotal_cents}`);
    if (rawRow.tax_cents !== 40000) throw new Error(`Expected tax_cents 40000, got ${rawRow.tax_cents}`);
    if (rawRow.total_cents !== 540000) throw new Error(`Expected total_cents 540000, got ${rawRow.total_cents}`);
  });

  // 4. Keyword search across multiple fields
  await test('4. Keyword search identifies terms across raw_text, supplier, and invoice number', async () => {
    // Search by word in rawText
    const res1 = repo.searchDocuments({ search: 'Procurement' });
    if (res1.total < 1) throw new Error('Search failed to find text in raw_text');

    // Search by invoice number
    const res2 = repo.searchDocuments({ search: '8800' });
    if (res2.total < 1) throw new Error('Search failed to find term in invoice_number');

    // Search by supplier name
    const res3 = repo.searchDocuments({ search: 'Apex Microelectronics' });
    if (res3.total < 1) throw new Error('Search failed to find term in supplier_name');

    // Search with non-matching term
    const res4 = repo.searchDocuments({ search: 'CompletelyUnrelatedTermXYZ' });
    if (res4.total !== 0) throw new Error('Search should return 0 for non-existent keyword');
  });

  // 5. Multi-criteria filtering
  await test('5. Multi-criteria filtering by status, file_type, dates, and monetary thresholds', async () => {
    // Seed second document
    const doc2Id = 'doc_test_filter_02';
    const now = new Date().toISOString();
    repo.saveDocument({
      id: doc2Id,
      originalFilename: 'ledger_sheet.xlsx',
      sanitizedFilename: 'ledger_sheet.xlsx',
      fileType: 'xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileSizeBytes: 54000,
      status: 'needs_review',
      createdAt: now,
      updatedAt: now,
      retryCount: 0,
      rawText: 'Spreadsheet quarterly breakdown',
      extraction: {
        invoice_number: 'XLS-991',
        invoice_date: '2026-11-01',
        supplier_name: 'Vanguard Systems',
        customer_name: 'Nexus Dynamics',
        subtotal: 150.00,
        tax: 15.00,
        total: 165.00,
        currency: 'USD',
        line_items: [],
        evidence: {},
        extraction_metadata: { mode: 'mock_rule_based', processing_time_ms: 5, warnings: [] },
      },
      auditTrail: [],
      errors: [],
      warnings: [],
    });

    // Filter by status = 'completed'
    const completedOnly = repo.searchDocuments({ status: 'completed' });
    if (completedOnly.total !== 1) throw new Error(`Expected 1 completed, got ${completedOnly.total}`);

    // Filter by fileType = 'xlsx'
    const xlsxOnly = repo.searchDocuments({ fileType: 'xlsx' });
    if (xlsxOnly.total !== 1) throw new Error(`Expected 1 xlsx, got ${xlsxOnly.total}`);

    // Filter by monetary total range: minTotal 1000
    const highValue = repo.searchDocuments({ minTotal: 1000 });
    if (highValue.total !== 1) throw new Error(`Expected 1 highValue doc, got ${highValue.total}`);
    if (highValue.items[0].id !== 'doc_test_persistence_01') throw new Error('Wrong highValue document matched');
  });

  // 6. Duplicate candidate lookup
  await test('6. Indexed duplicate candidate lookup detects normalized matching invoices', async () => {
    const duplicates = repo.findDuplicateCandidates('Apex Microelectronics, Inc.', 'INV-2026-8800');
    if (duplicates.length !== 1) throw new Error(`Expected 1 duplicate match, got ${duplicates.length}`);
    if (duplicates[0].id !== 'doc_test_persistence_01') throw new Error('Duplicate candidate ID mismatch');
  });

  // 7. Processing history logging
  await test('7. Processing history table records execution attempts and durations', async () => {
    repo.recordProcessingHistory('doc_test_persistence_01', 1, 'queued');
    repo.recordProcessingHistory('doc_test_persistence_01', 1, 'completed', 450);

    const history = repo.getProcessingHistory('doc_test_persistence_01');
    if (history.length !== 2) throw new Error(`Expected 2 history rows, got ${history.length}`);
    if (history[1].status !== 'completed') throw new Error('History status mismatch');
    if (history[1].durationMs !== 450) throw new Error('History duration mismatch');
  });

  // 8. Manual corrections audit trail persistence
  await test('8. Audit trail records field modifications with auditor details and reasons', async () => {
    repo.addAuditEntry('doc_test_persistence_01', {
      field: 'invoice_number',
      previousValue: 'INV-2026-8800',
      newValue: 'INV-2026-8800-REV1',
      reason: 'Supplier revised invoice number on amendment',
      author: 'senior_auditor',
      updatedAt: new Date().toISOString(),
    });

    const docWithAudit = repo.getDocument('doc_test_persistence_01');
    if (!docWithAudit) throw new Error('Failed to retrieve document with audit');
    if (docWithAudit.auditTrail.length !== 1) throw new Error(`Expected 1 audit entry, got ${docWithAudit.auditTrail.length}`);
    if (docWithAudit.auditTrail[0].newValue !== 'INV-2026-8800-REV1') throw new Error('Audit newValue mismatch');
    if (docWithAudit.auditTrail[0].author !== 'senior_auditor') throw new Error('Audit author mismatch');
  });

  // 9. Semantic search vector similarity and cosine ranking
  await test('9. Semantic search calculates genuine dense vector cosine similarity and ranks results', async () => {
    const mockDoc1: DocumentRecord = {
      id: 'doc_sem_1',
      originalFilename: 'hardware_invoice_nvidia.pdf',
      sanitizedFilename: 'hardware_invoice_nvidia.pdf',
      fileType: 'pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 2048,
      status: 'completed',
      retryCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rawText: 'NVIDIA RTX 4090 GPU graphics card hardware accelerator computation unit $1,800.00',
      extraction: {
        invoice_number: 'NV-2026-90',
        supplier_name: 'NVIDIA Corporation',
        subtotal: 1800,
        tax: 0,
        total: 1800,
        currency: 'USD',
        line_items: [{ description: 'Graphics Processor Card', quantity: 1, unit_price: 1800, amount: 1800 }]
      } as any,
      auditTrail: [],
      errors: [],
      warnings: [],
    };

    const mockDoc2: DocumentRecord = {
      id: 'doc_sem_2',
      originalFilename: 'catering_coffee_bill.pdf',
      sanitizedFilename: 'catering_coffee_bill.pdf',
      fileType: 'pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 512,
      status: 'completed',
      retryCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rawText: 'Starbucks coffee beans espresso beverage catering refreshments food supplies $45.00',
      extraction: {
        invoice_number: 'SB-11',
        supplier_name: 'Starbucks Coffee',
        subtotal: 45,
        tax: 0,
        total: 45,
        currency: 'USD',
      } as any,
      auditTrail: [],
      errors: [],
      warnings: [],
    };

    const searchRes = await semanticSearchService.search('GPU graphics accelerator computing', [mockDoc1, mockDoc2]);
    if (searchRes.results.length === 0) {
      throw new Error('Expected at least 1 match for GPU search');
    }
    if (searchRes.results[0].documentId !== 'doc_sem_1') {
      throw new Error(`Expected doc_sem_1 to rank highest for GPU query, got ${searchRes.results[0].documentId}`);
    }
    if (searchRes.results[0].similarityScore <= 0) {
      throw new Error(`Expected positive cosine similarity score, got ${searchRes.results[0].similarityScore}`);
    }
  });

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  return {
    total: results.length,
    passed,
    failed,
    results,
  };
}
