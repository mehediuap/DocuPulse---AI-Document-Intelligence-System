/**
 * Repeatable Database Migrations & DDL Definitions
 */

import Database from 'better-sqlite3';

export const SCHEMA_V1 = `
-- 1. Documents Table
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  original_filename TEXT NOT NULL,
  sanitized_filename TEXT NOT NULL,
  file_type TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  storage_path TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  uploaded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  processing_duration_ms INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  raw_text TEXT
);

CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_uploaded_at ON documents(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_documents_file_type ON documents(file_type);

-- 2. Extractions Table (Decimal-safe with integer cents)
CREATE TABLE IF NOT EXISTS extractions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE,
  invoice_number TEXT,
  invoice_date TEXT,
  supplier_name TEXT,
  customer_name TEXT,
  subtotal REAL,
  subtotal_cents INTEGER,
  tax REAL,
  tax_cents INTEGER,
  total REAL,
  total_cents INTEGER,
  currency TEXT,
  line_items_json TEXT,
  evidence_json TEXT,
  extraction_metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_extractions_supplier_invoice ON extractions(supplier_name, invoice_number);
CREATE INDEX IF NOT EXISTS idx_extractions_invoice_date ON extractions(invoice_date);
CREATE INDEX IF NOT EXISTS idx_extractions_total_cents ON extractions(total_cents);

-- 3. Validations Table
CREATE TABLE IF NOT EXISTS validations (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  error_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  is_reconciled INTEGER NOT NULL DEFAULT 0,
  issues_json TEXT,
  reconciliation_json TEXT,
  validated_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- 4. Processing History Table
CREATE TABLE IF NOT EXISTS processing_history (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_history_document ON processing_history(document_id, attempt_number);

-- 5. Audit Trail Table
CREATE TABLE IF NOT EXISTS audit_trail (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  field TEXT NOT NULL,
  previous_value TEXT,
  new_value TEXT,
  reason TEXT,
  author TEXT NOT NULL DEFAULT 'auditor',
  created_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_document ON audit_trail(document_id);

-- 6. Schema Migrations Version Tracker
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

export function runMigrations(db: Database.Database): void {
  // Execute base DDL in a transaction
  db.exec(SCHEMA_V1);

  const stmt = db.prepare('SELECT version FROM schema_migrations WHERE version = 1');
  const existing = stmt.get();

  if (!existing) {
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(
      new Date().toISOString()
    );
  }

  const columns = new Set(
    (db.pragma('table_info(documents)') as Array<{ name: string }>).map(column => column.name)
  );
  if (!columns.has('errors_json')) {
    db.exec('ALTER TABLE documents ADD COLUMN errors_json TEXT NOT NULL DEFAULT \'[]\'');
  }
  if (!columns.has('warnings_json')) {
    db.exec('ALTER TABLE documents ADD COLUMN warnings_json TEXT NOT NULL DEFAULT \'[]\'');
  }

  const versionTwo = db.prepare('SELECT version FROM schema_migrations WHERE version = 2').get();
  if (!versionTwo) {
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)').run(
      new Date().toISOString()
    );
  }

  const extractionColumns = new Set(
    (db.pragma('table_info(extractions)') as Array<{ name: string }>).map(column => column.name)
  );
  if (!extractionColumns.has('supplier_name_normalized')) {
    db.exec('ALTER TABLE extractions ADD COLUMN supplier_name_normalized TEXT');
  }
  if (!extractionColumns.has('invoice_number_normalized')) {
    db.exec('ALTER TABLE extractions ADD COLUMN invoice_number_normalized TEXT');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_extractions_normalized_duplicate
      ON extractions(supplier_name_normalized, invoice_number_normalized)
  `);

  const versionThree = db.prepare('SELECT version FROM schema_migrations WHERE version = 3').get();
  if (!versionThree) {
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)').run(
      new Date().toISOString()
    );
  }

  const versionFour = db.prepare('SELECT version FROM schema_migrations WHERE version = 4').get();
  if (!versionFour) {
    db.transaction(() => {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS audit_trail_no_update
        BEFORE UPDATE ON audit_trail
        BEGIN
          SELECT RAISE(ABORT, 'audit trail is append-only');
        END;

        CREATE TRIGGER IF NOT EXISTS audit_trail_no_delete
        BEFORE DELETE ON audit_trail
        BEGIN
          SELECT RAISE(ABORT, 'audit trail is append-only');
        END;
      `);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?)').run(
        new Date().toISOString()
      );
    })();
  }

  const versionFive = db.prepare('SELECT version FROM schema_migrations WHERE version = 5').get();
  if (!versionFive) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS processing_jobs (
          document_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          queued_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          error_message TEXT,
          FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_processing_jobs_status_queued
          ON processing_jobs(status, queued_at);

        INSERT OR IGNORE INTO processing_jobs (
          document_id, status, attempt_number, queued_at, updated_at, error_message
        )
        SELECT id, status, retry_count + 1, uploaded_at, updated_at, NULL
        FROM documents
        WHERE status IN ('queued', 'processing');

        CREATE TABLE IF NOT EXISTS search_embeddings (
          document_id TEXT NOT NULL,
          model TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          vector_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (document_id, model),
          FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        );
      `);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (5, ?)').run(
        new Date().toISOString()
      );
    })();
  }

  const versionSix = db.prepare('SELECT version FROM schema_migrations WHERE version = 6').get();
  if (!versionSix) {
    db.transaction(() => {
    const jobColumns = new Set(
      (db.pragma('table_info(processing_jobs)') as Array<{ name: string }>).map(column => column.name)
    );
    if (!jobColumns.has('lease_owner')) {
      db.exec('ALTER TABLE processing_jobs ADD COLUMN lease_owner TEXT');
    }
    if (!jobColumns.has('lease_expires_at')) {
      db.exec('ALTER TABLE processing_jobs ADD COLUMN lease_expires_at TEXT');
    }
    if (!jobColumns.has('heartbeat_at')) {
      db.exec('ALTER TABLE processing_jobs ADD COLUMN heartbeat_at TEXT');
    }

    db.exec(`
      UPDATE processing_jobs
      SET status = 'queued', updated_at = datetime('now')
      WHERE status = 'processing' AND lease_owner IS NULL;
      CREATE INDEX IF NOT EXISTS idx_processing_jobs_lease
        ON processing_jobs(status, lease_expires_at, queued_at);
    `);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?)').run(
      new Date().toISOString()
    );
    })();
  }
}
