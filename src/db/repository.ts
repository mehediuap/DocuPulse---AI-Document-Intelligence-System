/**
 * Document & Invoice Repository
 * Persistent storage layer providing CRUD, keyword search, multi-field filtering, and audit history.
 */

import Database from 'better-sqlite3';
import { db as defaultDb } from './database.ts';
import { DocumentRecord, AuditEntry, JobStatus } from '../services/api/types.ts';
import { InvoiceExtractionResult } from '../services/extraction/schemas.ts';
import { ValidationSummary } from '../services/validation/types.ts';
import { toCents, fromCents } from '../services/validation/decimalUtils.ts';
import { normalizeSupplierName, normalizeInvoiceNumber } from '../services/validation/duplicateDetector.ts';

export interface DocumentFilter {
  page?: number;
  limit?: number;
  status?: JobStatus;
  fileType?: string;
  supplierName?: string;
  invoiceNumber?: string;
  dateFrom?: string;
  dateTo?: string;
  minTotal?: number;
  maxTotal?: number;
  search?: string;
}

export class DocumentRepository {
  private db: Database.Database;

  constructor(customDb?: Database.Database) {
    this.db = customDb || defaultDb;
    this.backfillNormalizedDuplicateKeys();
  }

  private backfillNormalizedDuplicateKeys(): void {
    const rows = this.db.prepare(`
      SELECT document_id, supplier_name, invoice_number
      FROM extractions
      WHERE supplier_name IS NOT NULL AND invoice_number IS NOT NULL
        AND (supplier_name_normalized IS NULL OR invoice_number_normalized IS NULL)
    `).all() as Array<{ document_id: string; supplier_name: string | null; invoice_number: string | null }>;
    const update = this.db.prepare(`
      UPDATE extractions
      SET supplier_name_normalized = ?, invoice_number_normalized = ?
      WHERE document_id = ?
    `);
    const backfill = this.db.transaction(() => {
      for (const row of rows) {
        update.run(
          row.supplier_name ? normalizeSupplierName(row.supplier_name) : null,
          row.invoice_number ? normalizeInvoiceNumber(row.invoice_number) : null,
          row.document_id
        );
      }
    });
    backfill();
  }

  public checkConnection(): void {
    this.db.prepare('SELECT 1').get();
  }

  /**
   * Persists or updates a document record.
   */
  public saveDocument(doc: DocumentRecord): void {
    this.db.transaction(() => {
    const stmt = this.db.prepare(`
      INSERT INTO documents (
        id, original_filename, sanitized_filename, file_type, mime_type,
        file_size_bytes, storage_path, status, uploaded_at, updated_at,
        processing_duration_ms, retry_count, raw_text, errors_json, warnings_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        storage_path = COALESCE(excluded.storage_path, documents.storage_path),
        status = excluded.status,
        updated_at = excluded.updated_at,
        processing_duration_ms = excluded.processing_duration_ms,
        retry_count = excluded.retry_count,
        raw_text = excluded.raw_text,
        errors_json = excluded.errors_json,
        warnings_json = excluded.warnings_json
    `);

    stmt.run(
      doc.id,
      doc.originalFilename,
      doc.sanitizedFilename,
      doc.fileType,
      doc.mimeType,
      doc.fileSizeBytes,
      doc.storagePath || null,
      doc.status,
      doc.createdAt,
      doc.updatedAt,
      doc.processingDurationMs || null,
      doc.retryCount || 0,
      doc.rawText || null,
      JSON.stringify(doc.errors || []),
      JSON.stringify(doc.warnings || [])
    );

    if (doc.extraction) {
      this.saveExtraction(doc.id, doc.extraction);
    }

    if (doc.validation) {
      this.saveValidation(doc.id, doc.validation);
    }
    })();
  }

  public saveJobState(
    doc: DocumentRecord,
    attemptNumber: number,
    status: string,
    durationMs?: number,
    errorMessage?: string
  ): void {
    this.db.transaction(() => {
      this.saveDocument(doc);
      this.recordProcessingHistory(doc.id, attemptNumber, status, durationMs, errorMessage);
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO processing_jobs (document_id, status, attempt_number, queued_at, updated_at, error_message)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          status = excluded.status,
          attempt_number = excluded.attempt_number,
          queued_at = CASE WHEN excluded.status = 'queued' THEN excluded.queued_at ELSE processing_jobs.queued_at END,
          updated_at = excluded.updated_at,
          error_message = excluded.error_message
      `).run(
        doc.id,
        status,
        attemptNumber,
        status === 'queued' ? now : now,
        now,
        errorMessage || null
      );
    })();
  }

  public claimNextQueuedJob(
    workerId: string,
    leaseDurationMs: number
  ): { documentId: string; attemptNumber: number } | null {
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
    const claim = this.db.transaction(() => {
      const candidate = this.db.prepare(`
        SELECT document_id, attempt_number
        FROM processing_jobs
        WHERE status = 'queued'
          OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        ORDER BY queued_at ASC
        LIMIT 1
      `).get(nowIso) as { document_id: string; attempt_number: number } | undefined;
      if (!candidate) return null;

      const result = this.db.prepare(`
        UPDATE processing_jobs
        SET status = 'processing', lease_owner = ?, lease_expires_at = ?,
            heartbeat_at = ?, updated_at = ?, error_message = NULL
        WHERE document_id = ?
          AND (status = 'queued'
            OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
      `).run(workerId, leaseExpiresAt, nowIso, nowIso, candidate.document_id, nowIso);
      return result.changes === 1
        ? { documentId: candidate.document_id, attemptNumber: candidate.attempt_number }
        : null;
    });
    return claim.immediate();
  }

  public renewProcessingLease(documentId: string, workerId: string, leaseDurationMs: number): boolean {
    const now = new Date();
    const nowIso = now.toISOString();
    const result = this.db.prepare(`
      UPDATE processing_jobs
      SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
      WHERE document_id = ? AND status = 'processing' AND lease_owner = ?
        AND lease_expires_at > ?
    `).run(
      new Date(now.getTime() + leaseDurationMs).toISOString(),
      nowIso,
      nowIso,
      documentId,
      workerId,
      nowIso
    );
    return result.changes === 1;
  }

  public finishClaimedJob(
    doc: DocumentRecord,
    attemptNumber: number,
    workerId: string,
    status: string,
    durationMs?: number,
    errorMessage?: string
  ): boolean {
    const now = new Date().toISOString();
    const finish = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE processing_jobs
        SET status = ?, updated_at = ?, error_message = ?,
            lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL
        WHERE document_id = ? AND status = 'processing' AND lease_owner = ?
          AND lease_expires_at > ?
      `).run(status, now, errorMessage || null, doc.id, workerId, now);
      if (result.changes !== 1) return false;
      this.saveDocument(doc);
      this.recordProcessingHistory(doc.id, attemptNumber, status, durationMs, errorMessage);
      return true;
    });
    return finish.immediate();
  }

  public getDocumentStatusCounts(): Record<string, number> {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM documents GROUP BY status
    `).all() as Array<{ status: string; count: number }>;
    return Object.fromEntries(rows.map(row => [row.status, row.count]));
  }

  public getProcessingJobStatus(documentId: string): string | undefined {
    const row = this.db.prepare(
      'SELECT status FROM processing_jobs WHERE document_id = ?'
    ).get(documentId) as { status: string } | undefined;
    return row?.status;
  }

  public getSearchVector(documentId: string, model: string, contentHash: string): number[] | undefined {
    const row = this.db.prepare(`
      SELECT content_hash, vector_json
      FROM search_embeddings
      WHERE document_id = ? AND model = ?
    `).get(documentId, model) as { content_hash: string; vector_json: string } | undefined;
    if (!row || row.content_hash !== contentHash) return undefined;

    const vector: unknown = JSON.parse(row.vector_json);
    if (!Array.isArray(vector) || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error(`Stored search vector for document ${documentId} is malformed.`);
    }
    return vector;
  }

  public saveSearchVector(
    documentId: string,
    model: string,
    contentHash: string,
    vector: number[]
  ): void {
    if (vector.some(value => !Number.isFinite(value))) {
      throw new Error('Search vector contains a non-finite value.');
    }
    this.db.prepare(`
      INSERT INTO search_embeddings (document_id, model, content_hash, vector_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(document_id, model) DO UPDATE SET
        content_hash = excluded.content_hash,
        vector_json = excluded.vector_json,
        updated_at = excluded.updated_at
    `).run(documentId, model, contentHash, JSON.stringify(vector), new Date().toISOString());
  }

  public saveCorrection(doc: DocumentRecord, entries: AuditEntry[]): void {
    this.db.transaction(() => {
      this.saveDocument(doc);
      for (const entry of entries) this.addAuditEntry(doc.id, entry);
    })();
  }

  /**
   * Saves or updates structured extraction with decimal-safe integer cents.
   */
  public saveExtraction(documentId: string, extraction: InvoiceExtractionResult): void {
    const extId = `ext_${documentId}`;
    const subtotalCents = extraction.subtotal !== null ? toCents(extraction.subtotal) : null;
    const taxCents = extraction.tax !== null ? toCents(extraction.tax) : null;
    const totalCents = extraction.total !== null ? toCents(extraction.total) : null;

    const stmt = this.db.prepare(`
      INSERT INTO extractions (
        id, document_id, invoice_number, invoice_date, supplier_name,
        customer_name, subtotal, subtotal_cents, tax, tax_cents,
        total, total_cents, currency, line_items_json, evidence_json,
        extraction_metadata_json, created_at, supplier_name_normalized,
        invoice_number_normalized
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_id) DO UPDATE SET
        invoice_number = excluded.invoice_number,
        invoice_date = excluded.invoice_date,
        supplier_name = excluded.supplier_name,
        customer_name = excluded.customer_name,
        subtotal = excluded.subtotal,
        subtotal_cents = excluded.subtotal_cents,
        tax = excluded.tax,
        tax_cents = excluded.tax_cents,
        total = excluded.total,
        total_cents = excluded.total_cents,
        currency = excluded.currency,
        line_items_json = excluded.line_items_json,
        evidence_json = excluded.evidence_json,
        extraction_metadata_json = excluded.extraction_metadata_json,
        supplier_name_normalized = excluded.supplier_name_normalized,
        invoice_number_normalized = excluded.invoice_number_normalized
    `);

    stmt.run(
      extId,
      documentId,
      extraction.invoice_number,
      extraction.invoice_date,
      extraction.supplier_name,
      extraction.customer_name,
      extraction.subtotal,
      subtotalCents,
      extraction.tax,
      taxCents,
      extraction.total,
      totalCents,
      extraction.currency,
      JSON.stringify(extraction.line_items || []),
      JSON.stringify(extraction.evidence || {}),
      JSON.stringify(extraction.extraction_metadata || {}),
      new Date().toISOString(),
      extraction.supplier_name ? normalizeSupplierName(extraction.supplier_name) : null,
      extraction.invoice_number ? normalizeInvoiceNumber(extraction.invoice_number) : null
    );
  }

  /**
   * Saves or updates validation result.
   */
  public saveValidation(documentId: string, validation: ValidationSummary): void {
    const valId = `val_${documentId}`;
    const stmt = this.db.prepare(`
      INSERT INTO validations (
        id, document_id, status, error_count, warning_count,
        is_reconciled, issues_json, reconciliation_json, validated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_id) DO UPDATE SET
        status = excluded.status,
        error_count = excluded.error_count,
        warning_count = excluded.warning_count,
        is_reconciled = excluded.is_reconciled,
        issues_json = excluded.issues_json,
        reconciliation_json = excluded.reconciliation_json,
        validated_at = excluded.validated_at
    `);

    stmt.run(
      valId,
      documentId,
      validation.status,
      validation.errorCount,
      validation.warningCount,
      validation.reconciliation?.isReconciled ? 1 : 0,
      JSON.stringify(validation.issues || []),
      JSON.stringify(validation.reconciliation || {}),
      validation.validatedAt || new Date().toISOString()
    );
  }

  /**
   * Appends an entry to the processing history.
   */
  public recordProcessingHistory(
    documentId: string,
    attemptNumber: number,
    status: string,
    durationMs?: number,
    errorMessage?: string
  ): void {
    const histId = `hist_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO processing_history (
        id, document_id, attempt_number, status, duration_ms, started_at, completed_at, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      histId,
      documentId,
      attemptNumber,
      status,
      durationMs || null,
      now,
      now,
      errorMessage || null
    );
  }

  /**
   * Appends an audit entry for manual correction.
   */
  public addAuditEntry(documentId: string, entry: AuditEntry): void {
    const auditId = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.db.prepare(`
      INSERT INTO audit_trail (
        id, document_id, field, previous_value, new_value, reason, author, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      auditId,
      documentId,
      entry.field,
      entry.previousValue !== null && entry.previousValue !== undefined ? String(entry.previousValue) : null,
      entry.newValue !== null && entry.newValue !== undefined ? String(entry.newValue) : null,
      entry.reason || null,
      entry.author || 'auditor',
      entry.updatedAt || new Date().toISOString()
    );
  }

  /**
   * Retrieves a document record with related extraction, validation, and audit trail.
   */
  public getDocument(id: string): DocumentRecord | null {
    const docRow = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as any;
    if (!docRow) return null;

    const extRow = this.db.prepare('SELECT * FROM extractions WHERE document_id = ?').get(id) as any;
    const valRow = this.db.prepare('SELECT * FROM validations WHERE document_id = ?').get(id) as any;
    const auditRows = this.db.prepare('SELECT * FROM audit_trail WHERE document_id = ? ORDER BY created_at ASC').all(id) as any[];

    let extraction: InvoiceExtractionResult | null = null;
    if (extRow) {
      extraction = {
        invoice_number: extRow.invoice_number,
        invoice_date: extRow.invoice_date,
        supplier_name: extRow.supplier_name,
        customer_name: extRow.customer_name,
        subtotal: extRow.subtotal,
        tax: extRow.tax,
        total: extRow.total,
        currency: extRow.currency,
        line_items: extRow.line_items_json ? JSON.parse(extRow.line_items_json) : [],
        evidence: extRow.evidence_json ? JSON.parse(extRow.evidence_json) : {},
        extraction_metadata: extRow.extraction_metadata_json ? JSON.parse(extRow.extraction_metadata_json) : {},
      };
    }

    let validation: ValidationSummary | null = null;
    if (valRow) {
      validation = {
        status: valRow.status,
        errorCount: valRow.error_count,
        warningCount: valRow.warning_count,
        issues: valRow.issues_json ? JSON.parse(valRow.issues_json) : [],
        errors: [],
        warnings: [],
        manualReviewRequired: valRow.status !== 'valid',
        reasonsForManualReview: [],
        reconciliation: valRow.reconciliation_json ? JSON.parse(valRow.reconciliation_json) : { isReconciled: valRow.is_reconciled === 1 },
        validatedAt: valRow.validated_at,
        totalIssues: valRow.error_count + valRow.warning_count,
      };
    }

    const auditTrail: AuditEntry[] = auditRows.map(r => ({
      field: r.field,
      previousValue: r.previous_value,
      newValue: r.new_value,
      reason: r.reason,
      author: r.author,
      updatedAt: r.created_at,
    }));

    return {
      id: docRow.id,
      originalFilename: docRow.original_filename,
      sanitizedFilename: docRow.sanitized_filename,
      fileType: docRow.file_type,
      mimeType: docRow.mime_type,
      fileSizeBytes: docRow.file_size_bytes,
      status: docRow.status,
      createdAt: docRow.uploaded_at,
      updatedAt: docRow.updated_at,
      processingDurationMs: docRow.processing_duration_ms,
      retryCount: docRow.retry_count,
      storagePath: docRow.storage_path || undefined,
      rawText: docRow.raw_text,
      extraction,
      validation,
      auditTrail,
      errors: docRow.errors_json ? JSON.parse(docRow.errors_json) : [],
      warnings: docRow.warnings_json ? JSON.parse(docRow.warnings_json) : [],
    };
  }

  public getAllDocuments(): DocumentRecord[] {
    const rows = this.db.prepare('SELECT id FROM documents ORDER BY uploaded_at DESC').all() as Array<{ id: string }>;
    return rows.map(row => this.getDocument(row.id)).filter((doc): doc is DocumentRecord => doc !== null);
  }

  public getInvoiceExtractionsExcept(documentId: string): InvoiceExtractionResult[] {
    const rows = this.db.prepare(`
      SELECT invoice_number, invoice_date, supplier_name, customer_name,
             subtotal, tax, total, currency, line_items_json, evidence_json,
             extraction_metadata_json
      FROM extractions
      WHERE document_id <> ?
    `).all(documentId) as Array<{
      invoice_number: string | null;
      invoice_date: string | null;
      supplier_name: string | null;
      customer_name: string | null;
      subtotal: number | null;
      tax: number | null;
      total: number | null;
      currency: string | null;
      line_items_json: string | null;
      evidence_json: string | null;
      extraction_metadata_json: string | null;
    }>;
    return rows.map(row => ({
      invoice_number: row.invoice_number,
      invoice_date: row.invoice_date,
      supplier_name: row.supplier_name,
      customer_name: row.customer_name,
      subtotal: row.subtotal,
      tax: row.tax,
      total: row.total,
      currency: row.currency,
      line_items: row.line_items_json ? JSON.parse(row.line_items_json) : [],
      evidence: row.evidence_json ? JSON.parse(row.evidence_json) : {},
      extraction_metadata: row.extraction_metadata_json
        ? JSON.parse(row.extraction_metadata_json)
        : { mode: 'mock_rule_based', processing_time_ms: 0, warnings: [] },
    }));
  }

  /**
   * Retrieves processing history for a document.
   */
  public getProcessingHistory(documentId: string): Array<{
    attemptNumber: number;
    status: string;
    durationMs?: number;
    startedAt: string;
    errorMessage?: string;
  }> {
    const rows = this.db.prepare(`
      SELECT * FROM processing_history WHERE document_id = ? ORDER BY attempt_number ASC
    `).all(documentId) as any[];

    return rows.map(r => ({
      attemptNumber: r.attempt_number,
      status: r.status,
      durationMs: r.duration_ms,
      startedAt: r.started_at,
      errorMessage: r.error_message,
    }));
  }

  /**
   * Looks up duplicate candidate invoices using indexed supplier and invoice number lookup.
   */
  public findDuplicateCandidates(supplierName: string, invoiceNumber: string): DocumentRecord[] {
    if (!supplierName || !invoiceNumber) return [];

    const normSupplier = normalizeSupplierName(supplierName);
    const normNumber = normalizeInvoiceNumber(invoiceNumber);

    const candidates = this.db.prepare(`
      SELECT document_id FROM extractions
      WHERE supplier_name_normalized = ? AND invoice_number_normalized = ?
    `).all(normSupplier, normNumber) as Array<{ document_id: string }>;

    return candidates.map(row => this.getDocument(row.document_id)!).filter(Boolean);
  }

  /**
   * Advanced multi-filter and keyword search.
   */
  public searchDocuments(options: DocumentFilter): { items: DocumentRecord[]; total: number } {
    const page = Math.max(1, options.page || 1);
    const limit = Math.max(1, Math.min(100, options.limit || 10));
    const offset = (page - 1) * limit;

    const conditions: string[] = ['1=1'];
    const params: any[] = [];

    // Filter: Status
    if (options.status) {
      conditions.push('d.status = ?');
      params.push(options.status);
    }

    // Filter: File Type
    if (options.fileType) {
      conditions.push('d.file_type = ?');
      params.push(options.fileType);
    }

    // Filter: Supplier Name
    if (options.supplierName) {
      conditions.push('e.supplier_name LIKE ?');
      params.push(`%${options.supplierName}%`);
    }

    // Filter: Invoice Number
    if (options.invoiceNumber) {
      conditions.push('e.invoice_number LIKE ?');
      params.push(`%${options.invoiceNumber}%`);
    }

    // Filter: Date range
    if (options.dateFrom) {
      conditions.push('e.invoice_date >= ?');
      params.push(options.dateFrom);
    }
    if (options.dateTo) {
      conditions.push('e.invoice_date <= ?');
      params.push(options.dateTo);
    }

    // Filter: Min/Max total (using decimal-safe cents)
    if (options.minTotal !== undefined) {
      conditions.push('e.total_cents >= ?');
      params.push(toCents(options.minTotal));
    }
    if (options.maxTotal !== undefined) {
      conditions.push('e.total_cents <= ?');
      params.push(toCents(options.maxTotal));
    }

    // Keyword Search across text, filename, supplier, customer, invoice_number
    if (options.search) {
      const term = `%${options.search.trim()}%`;
      conditions.push(`(
        d.original_filename LIKE ? OR
        d.sanitized_filename LIKE ? OR
        d.id LIKE ? OR
        d.raw_text LIKE ? OR
        e.supplier_name LIKE ? OR
        e.customer_name LIKE ? OR
        e.invoice_number LIKE ?
      )`);
      params.push(term, term, term, term, term, term, term);
    }

    const whereClause = conditions.join(' AND ');

    // Count query
    const countQuery = `
      SELECT COUNT(DISTINCT d.id) as count
      FROM documents d
      LEFT JOIN extractions e ON d.id = e.document_id
      WHERE ${whereClause}
    `;
    const countRow = this.db.prepare(countQuery).get(...params) as any;
    const total = countRow ? countRow.count : 0;

    // Fetch paginated documents
    const selectQuery = `
      SELECT DISTINCT d.id
      FROM documents d
      LEFT JOIN extractions e ON d.id = e.document_id
      WHERE ${whereClause}
      ORDER BY d.uploaded_at DESC
      LIMIT ? OFFSET ?
    `;
    const rows = this.db.prepare(selectQuery).all(...params, limit, offset) as any[];
    const items = rows.map(r => this.getDocument(r.id)!).filter(Boolean);

    return {
      items,
      total,
    };
  }
}

export const documentRepository = new DocumentRepository();
