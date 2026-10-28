# DocuPulse — AI-Powered Document Intelligence System

Enterprise-grade document intelligence platform designed for automated ingestion, OCR extraction, structured normalization, mathematical validation, REST API management, and semantic search across invoices, financial ledgers, and tabular documents.

---

## Module 1: Multi-Format Document Processing

Provides robust, fault-tolerant ingestion pipelines for business documents and spreadsheets across digital and scanned formats.

### Supported File Types & Boundaries

| Format | Extension | Capabilities | Boundary Preservation |
| :--- | :--- | :--- | :--- |
| **Digital PDF** | `.pdf` | Native text operator extraction (`BT..ET`, `Tj`, `TJ`); page assignment is heuristic | Page labels are preserved; exact source layout is not guaranteed |
| **Scanned PDF** | `.pdf` | Image-only PDFs are routed to OCR; a configured OCR provider is required for text | Current OCR call processes the document as one page |
| **Images** | `.jpg`, `.jpeg`, `.png` | Dimension header parsing (SOF0/IHDR) and OCR when a provider is configured | Document boundary with provider confidence |
| **Multi-page TIFF** | `.tif`, `.tiff` | Traverses Image File Directories (IFD chain) and reports frame count | OCR text is not yet isolated per frame; a warning is emitted |
| **Modern Spreadsheets** | `.xlsx` | OpenXML workbook parsing with multi-sheet extraction | Preserves multiple worksheet tabs, row coordinates, column headers |
| **Legacy Spreadsheets** | `.xls` | BIFF8/BIFF5 binary parser with backward-compatibility audit | Worksheet tabs and cell grids |
| **Delimited Data** | `.csv` | RFC-4180 parsing with auto-detected delimiter (`,`, `;`, `\t`, `\|`) & multi-line quoted fields | Row numbers and column headers |

---

## Module 2: AI Information Extraction

Transforms raw unformatted document text into validated, schema-compliant JSON structures.

### Extracted Invoice Fields
- `invoice_number`: Unique invoice identifier (or `null` if absent)
- `invoice_date`: Issue date (or `null` if absent)
- `supplier_name`: Legal or commercial name of billing entity (or `null` if absent)
- `customer_name`: Name of recipient client (or `null` if absent)
- `subtotal`: Net monetary amount before taxes (or `null` if absent)
- `tax`: Total tax amount (or `null` if absent)
- `total`: Gross payable amount (or `null` if absent)
- `currency`: ISO-4217 currency code (e.g. `USD`, `EUR`, `GBP`)
- `line_items`: Array of items containing `description`, `quantity`, `unit_price`, `amount`, and `evidence`
- `evidence`: Provenance dictionary mapping field names to verbatim source text quotes and page references
- `extraction_metadata`: Execution duration, adapter mode, model alias, and processing warnings

### Pydantic Schema & Reference Files
- **Pydantic Schema:** `schemas/invoice_schema.py`
- **Canonical Output Example:** `schemas/example_invoice.json`
- **Runtime Schema Validator:** `src/services/extraction/schemas.ts`
- **Isolated Extraction Prompts:** `src/services/extraction/prompts.ts`
- **LLM & Rule-Based Adapters:** `src/services/extraction/llmAdapter.ts`

### Extraction Adapters & Configuration
1. **Mock / Rule-Based Adapter (`MockRuleBasedAdapter`):**
   - Deterministic offline regex and tabular pattern extraction.
   - Requires zero network calls and no paid API keys.
   - Strictly sets missing fields to `null` without hallucination.
   - Configured via `EXTRACTION_MODE="mock"`.
2. **Gemini LLM Adapter (`GeminiExtractionAdapter`):**
   - Calls `@google/genai` with the configured model (default: `gemini-3.1-flash-lite`).
   - Strictly grounded via `INVOICE_EXTRACTION_SYSTEM_INSTRUCTION`.
   - Defended with configurable timeouts and rate-limit handling.
   - Configured via `EXTRACTION_MODE="gemini"` and either `GEMINI_API_KEY` or Vertex AI (`GOOGLE_GENAI_USE_VERTEXAI="true"`, `GOOGLE_PROJECT_ID`, and Application Default Credentials).

### Google GenAI Environment
Copy `.env.example` to `.env` and set `GEMINI_API_KEY` for Gemini API key authentication. The Google project ID and number are included as project metadata; Vertex AI uses the project ID and `GOOGLE_CLOUD_LOCATION` (default `us-central1`) with Application Default Credentials. Runtime configuration is guarded so importing the OCR or extraction modules in a browser does not access Node.js environment globals.

### Sensitive Data Protection
By default, full invoice contents are excluded from standard system logs. Redacted summaries are output instead (`[REDACTED]`). Sensitive content logging can be enabled in isolated debug environments via `ENABLE_SENSITIVE_LOGGING="true"`.

### Measured Accuracy & Limitations
The deterministic extractor is measured against the labeled synthetic dataset described in Module 7 below. These benchmark results characterize this dataset only and do not establish production accuracy or live Gemini/OCR performance.

---

## Module 3: Data Validation & Financial Reconciliation

A standalone, deterministic validation service that validates business rules, dates, duplicate candidates, and financial arithmetic without ever mutating source data.

### Validation Status Resolution
* **`valid`**: Zero errors and zero warnings. Stated amounts reconcile within tolerance.
* **`needs_review`**: No confirmed contradictions, but required evidence is missing or uncertain, or a review warning is present (e.g., duplicate candidate, low extraction confidence, unstated currency).
* **`invalid`**: A confirmed contradiction or malformed value is present (e.g., invalid calendar date, arithmetic mismatch).

### Stable Validation Issue Codes
| Issue Code | Severity | Description |
| :--- | :--- | :--- |
| `MISSING_REQUIRED_FIELD` | `warning` | Mandatory field (`invoice_number`, `invoice_date`, `supplier_name`, `total`) is null and needs human review. |
| `FIELD_UNCERTAIN` | `warning` | Field extracted with confidence below threshold (`< 0.70`). |
| `INVALID_DATE_FORMAT` | `error` | Date cannot be parsed into a calendar date (e.g. `2026-02-31`). |
| `FUTURE_DATE_WARNING` | `warning` | Issue date is more than grace period (7 days) in the future. |
| `INVALID_NUMERIC_VALUE` | `error` | Field is NaN or non-finite. |
| `NEGATIVE_AMOUNT_SUSPICIOUS`| `warning` | Amount is negative; flagged for manual credit memo review. |
| `ZERO_AMOUNT_SUSPICIOUS` | `warning` | Invoice total is $0.00; flagged for zero-balance review. |
| `ARITHMETIC_SUBTOTAL_MISMATCH` | `error` | Sum of itemized line items does not equal stated subtotal. |
| `ARITHMETIC_TOTAL_MISMATCH` | `error` | Subtotal + Tax does not equal stated Total beyond tolerance. |
| `LINE_ITEM_CALCULATION_MISMATCH` | `error` | Line item Quantity × Unit Price contradicts the stated line amount. |
| `DUPLICATE_INVOICE_CANDIDATE` | `warning` | Matching supplier name + invoice number pair identified. |
| `MISSING_CURRENCY` | `warning` | Currency code not specified on document. |
| `ROUNDING_TOLERANCE_EXCEEDED`| `info` | Minor variance within rounding tolerance ($0.05). |

### Financial Reconciliation & Decimal Safety
All calculations use integer cents arithmetic (`toCents`, `fromCents`, `addDecimals`, `subtractDecimals`) to prevent IEEE-754 precision drift.
- **Subtotal + Tax Reconciliation:** `expectedTotal = subtotal + (tax || 0)`.
- **Rounding Tolerance:** Defaults to `$0.05` (5 cents). Deltas $\le \$0.05$ reconcile with a minor rounding notice; deltas $> \$0.05$ trigger `ARITHMETIC_TOTAL_MISMATCH`.

---

## Module 4: Backend REST API & Background Job Queue

DocuPulse provides a full-stack REST API with an asynchronous background queue, concurrency control, manual correction audit logs, and OpenAPI documentation.

### API Endpoints

| Method | Path | Description | Status Code |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/documents` | Upload single/multiple documents and enqueue background processing jobs | `202 Accepted` |
| `GET` | `/api/v1/documents/{document_id}` | Retrieve document metadata, lifecycle status, and duration | `200 OK` |
| `GET` | `/api/v1/documents/{document_id}/result` | Retrieve structured extraction, validation reconciliation, and audit trail | `200 OK` |
| `GET` | `/api/v1/documents` | Paginated listing with filtering by status and keyword search | `200 OK` |
| `PATCH` | `/api/v1/documents/{document_id}/corrections` | Apply manual field correction with immutable audit trail and revalidation | `200 OK` |
| `POST` | `/api/v1/documents/{document_id}/retry` | Safely retry failed or flagged jobs with concurrency protection | `200 OK` / `409 Conflict` |
| `GET` | `/health` | System health check and queue status metrics | `200 OK` |
| `GET` | `/api/v1/openapi.json` | OpenAPI 3.0 specification reflecting all request/response models | `200 OK` |

### Background Queue Abstraction
* **Status Lifecycle:** `queued` $\rightarrow$ `processing` $\rightarrow$ `completed` / `needs_review` / `invalid` / `failed`. A missing/uncertain extraction is `needs_review`; confirmed contradictions remain `invalid`.
* **Concurrency Lock:** Active jobs are tracked per document ID. Calling `/retry` on a currently processing document returns `409 Conflict`, preventing duplicate race conditions.
* **Separation of Concerns:** Long-running OCR and AI inference execute asynchronously without blocking HTTP upload requests.
* **Durable retry:** Original bytes are stored atomically under `data/uploads/` (or `DOCUPULSE_UPLOAD_DIR`) and the path, lifecycle state, errors, and warnings are persisted in SQLite. Queued or interrupted processing jobs are recovered on startup; jobs whose source file is missing are explicitly marked failed instead of appearing retryable.
* **Repository isolation:** Queue workers use the repository supplied by their controller, keeping in-memory integration tests and alternate databases isolated from the application database.

### Audit Trail for Manual Corrections
Manual adjustments via `PATCH /api/v1/documents/{id}/corrections` are recorded with:
* `field`: Corrected schema property
* `previous_value` & `new_value`: Values before and after correction
* `updated_at`: ISO timestamp
* `reason`: Auditor justification
* `author`: User or auditor identity

### Authentication & Deployment Disclosure
> **Security Notice:** As this is a local assessment demonstration, authentication is currently unconfigured. **This environment is not safe for public deployment without RBAC/OAuth and TLS.**

---

## Module 5: Database and Search

DocuPulse provides persistent relational storage with idempotent schema migrations, decimal-safe integer cents storage, composite indexes for high-throughput queries, multi-criteria filtering, keyword full-text search, and transparent semantic search fallback.

### Database Architecture & Dual ORM Strategy

1. **Python / SQLAlchemy Specification (`database/models.py`, `database/connection.py`):**
   - Declarative SQLAlchemy models compatible with SQLite (`sqlite:///./docupulse.db`) and PostgreSQL (`postgresql+psycopg2://user:pass@host/dbname`).
   - Configurable engine with pooling, transaction isolation, and foreign key enforcement.
2. **Active TypeScript / SQLite Repository (`src/db/`):**
   - Built on `better-sqlite3` with Write-Ahead Logging (`WAL` mode) and strict foreign key constraints.
   - Fully isolated in-memory test databases (`createInMemoryDatabase()`) for hermetic offline test runs.

### Database Schema & Tables

| Table | Primary Key | Description & Key Columns | Indexes |
| :--- | :--- | :--- | :--- |
| `documents` | `id` (TEXT) | Ingested document records, original filename, storage path, MIME type, size, upload timestamp, and processing status | `idx_documents_status`, `idx_documents_created_at`, `idx_documents_file_type` |
| `extractions` | `id` (TEXT) | Structured extraction results, normalized fields, ISO dates, integer cents (`subtotal_cents`, `tax_cents`, `total_cents`), JSON line items, and JSON evidence provenance | `idx_extractions_supp_inv`, `idx_extractions_total_cents`, `idx_extractions_doc_id` |
| `validations` | `id` (TEXT) | Validation outcome (`valid`, `needs_review`, `invalid`), error count, warning count, JSON issues array, and review reason | `idx_validations_doc_id`, `idx_validations_status` |
| `processing_history` | `id` (TEXT) | Chronological log of processing attempts, duration in ms, attempt count, timestamp, and error messages | `idx_history_doc_id`, `idx_history_created_at` |
| `audit_trail` | `id` (TEXT) | Immutable record of manual field adjustments, original vs modified values, auditor identity, timestamp, and justification | `idx_audit_trail_doc_id`, `idx_audit_trail_timestamp` |
| `schema_migrations` | `version` (INT) | Migration version registry tracking idempotent schema application | Primary key on `version` |

### Decimal-Safe Financial Storage

To prevent IEEE-754 precision drift (e.g. `$0.10 + $0.20 = $0.30000000000000004`):
- All currency amounts are converted to exact integer cents (`subtotal_cents`, `tax_cents`, `total_cents`) using `toCents()` upon database write.
- Repository retrieval reconstructs decimal precision using `fromCents()` without rounding loss.
- Normalized supplier/invoice keys support indexed duplicate-candidate lookup; manual corrections are type-checked, revalidated by default, and committed with their audit entries in one database transaction.

### Search Capabilities & Semantic Fallback Disclosure

1. **Full-Text Keyword Search:**
   - Multi-field search querying extracted text streams (`raw_text`), `supplier_name`, and `invoice_number`.
   - Case-insensitive substring matching and token scanning.
2. **Multi-Criteria Filtering:**
   - Filter documents by lifecycle status (`completed`, `needs_review`, `failed`, `queued`).
   - Filter by file extension/MIME type (`pdf`, `xlsx`, `csv`, `image`).
   - Filter by date range (`dateFrom`, `dateTo`) and financial thresholds (`minTotal`, `maxTotal`).
3. **Semantic Search & Fallback Transparency:**
   - Implemented via `SemanticSearchService` with cosine similarity (`cosineSimilarity`).
   - When vector embedding credentials (`gemini-embedding-2-preview`) are unconfigured, the system **strictly avoids mislabeling keyword search as semantic search**.
   - Instead, it explicitly returns `mode: "fallback_unavailable"` alongside a descriptive `limitationNotice` instructing the client to utilize full-text keyword search.

### Data Privacy & Retention Policy

- **No Real Customer Data in Source:** All synthetic test data and fixtures avoid committing real invoices, PII, or company financial records.
- **Configurable Retention:** Supports document purging (`documentRepository.delete(documentId)`) which cascade-deletes associated extractions, validations, processing logs, and audit entries.
- **Sensitive Log Redaction:** Extracted raw document contents are excluded from standard system logs and only stored in designated, access-controlled database tables.

---

## Automated Test Suite (52 Tests)

A comprehensive suite of 52 automated tests validates Modules 1, 2, 3, 4, and 5 completely offline without requiring paid API access.

### Running the Tests via CLI
```bash
npm run test
```

### Verified Test Cases
#### Module 1: Document Processing (13 Tests)
1. `Digital PDF page-level text extraction`
2. `Multi-page PDF page indexing and boundaries`
3. `Scanned PDF detection and OCR routing`
4. `Image processing (PNG / JPEG) with dimension extraction and OCR`
5. `Multi-page TIFF directory traversal & detection`
6. `Multi-worksheet XLSX boundary and coordinate preservation`
7. `Legacy XLS (BIFF8) processing and compatibility warning`
8. `CSV auto-delimiter detection and RFC-4180 quoted fields`
9. `Empty file (0 bytes) rejected with structured error`
10. `Corrupted file handles errors gracefully without crashing`
11. `Unsupported format rejected with informative error`
12. `Path traversal and malicious filename sanitization`
13. `Multi-file batch fault-isolation (corrupt file does not stop batch)`

#### Module 2: AI Information Extraction (8 Tests)
1. `Complete invoice extraction (mock/rule-based mode)`
2. `Missing fields return null without hallucination`
3. `Tabular line items extraction with evidence & coordinates`
4. `Schema validation catches malformed JSON & cleans amounts`
5. `Timeout handling aborts safely on slow execution`
6. `Provider failure returns structured result with warning`
7. `ExtractionFactory creates MockRuleBasedAdapter by default/config`
8. `End-to-end pipeline: Task 1 document parsing to validated JSON`

#### Module 3: Data Validation & Reconciliation (11 Tests)
1. `Clean, valid invoice passes with "valid" status and zero errors`
2. `Missing required fields (invoice_number, date, supplier, total) flagged as invalid`
3. `Duplicate invoice candidate detected via normalized supplier and number`
4. `Configurable rounding tolerance handles minor cent variance`
5. `Line items sum versus subtotal arithmetic reconciliation`
6. `Negative or zero amounts flagged for review without silent modification`
7. `Missing currency flagged with MISSING_CURRENCY warning`
8. `Invalid calendar date (e.g. Feb 31) caught as INVALID_DATE_FORMAT`
9. `Decimal safety verified with fractional cents operations (0.1 + 0.2)`

#### Module 4: Backend REST API & Job Queue (11 Tests)
1. `Upload endpoint (POST /api/v1/documents) accepts multiple files and queues jobs`
2. `Metadata & status endpoint (GET /api/v1/documents/{id}) returns job state`
3. `Result endpoint (GET /api/v1/documents/{id}/result) provides extraction and validation`
4. `List endpoint (GET /api/v1/documents) supports pagination, filtering, and search`
5. `Corrections endpoint (PATCH /api/v1/documents/{id}/corrections) records audit trail`
6. `Retry endpoint (POST /api/v1/documents/{id}/retry) requeues job with concurrency lock`
7. `Input validation rejects unsupported types, empty uploads, and non-existent IDs`
8. `Health endpoint (GET /health) returns queue metrics, database state, and assessment auth warning`
9. `Cross-verification endpoint reconciles extracted documents`
10. `Semantic search endpoint returns ranked vector matches`
11. `Queue workers write through their injected repository and recover durable source files`

#### Module 5: Database and Search (9 Tests)
1. `Schema initialization and repeatable migrations execute idempotently`
2. `Full document persistence stores metadata, extraction, and validation`
3. `Decimal-safe financial persistence stores exact integer cents without drift`
4. `Keyword search identifies terms across raw_text, supplier, and invoice number`
5. `Multi-criteria filtering by status, file_type, dates, and monetary thresholds`
6. `Indexed duplicate candidate lookup detects normalized matching invoices`
7. `Processing history table records execution attempts and durations`
8. `Audit trail records field modifications with auditor details and reasons`
9. `Semantic search reports truthful fallback when embedding provider is unconfigured`

---

### Module 6: Frontend Dashboard (Task 6)

The frontend provides an accessible, responsive single-page web dashboard integrated directly with the backend REST API and SQLite state engine.

#### Dashboard Capabilities & Architecture
- **Queue & System Health Monitor (`QueueHealthBanner`)**: Real-time counter metrics for queued, processing, completed, needs-review, and failed documents; live polling of `/health`.
- **Multi-File Drag-and-Drop Ingestion (`UploadDropzone`)**:
  - Accepts all 7 supported formats: digital & scanned PDFs, raster images (`.png`, `.jpg`, `.jpeg`), TIFF (`.tif`, `.tiff`), OpenXML spreadsheets (`.xlsx`), legacy spreadsheets (`.xls`), and delimited tabular text (`.csv`).
  - Client-side pre-flight validation enforcing the 25 MB file bounds and allowed media types.
  - Base64 streaming transmission to `POST /api/v1/documents`.
- **Verified Demo Fixtures Drawer**: One-click synthetic fixtures (Compliant Invoice, Math Discrepancy, Duplicate Candidate, Scanned Receipt, Multi-Sheet XLSX, Semicolon CSV, Corrupted Stream) directly injected into the live backend pipeline without hardcoded mocks.
- **Documents Table & Controls (`DocumentTable`)**:
  - Keyword search across filenames, invoice numbers, supplier names, and document IDs.
  - Status filtering (`queued`, `processing`, `completed`, `needs_review`, `invalid`, `failed`).
  - Paginated table with latency durations, file metadata badges, and direct actions.
- **Document Detail Inspector Modal (`DocumentDetailModal`)**:
  - **Extracted Information Tab**: Core entities (Invoice #, Date, Supplier, Customer, Subtotal, Tax, Total, Currency) with confidence metrics and itemized line items table.
  - **Validation & Rules Tab**: Visual verdict (`Fully Validated` vs `Needs Auditor Review`), financial balance reconciliation card (Stated Subtotal + Stated Tax vs Expected vs Stated Total with discrepancy delta), and itemized issue badges with severity, code, message, and evidence.
  - **Manual Correction Tab**: Interactive auditor correction form allowing field selection, current value display, new value entry, required audit justification, and immediate re-validation toggle calling `PATCH /api/v1/documents/:id/corrections`.
  - **Audit Trail Tab**: Chronological audit log showing previous value → new value, modification timestamp, author, and reason.
  - **Retry Action**: One-click safe retry calling `POST /api/v1/documents/:id/retry` with concurrency locks.
- **Automated Verification Suite Runner**: Built-in visual test runner executing hermetic verification checks across Modules 1, 2, and 3 directly inside the browser.
- **Configuration**: Driven by `VITE_API_BASE_URL` in `.env` (defaults to relative `/api/v1` for same-origin deployment).

---

## Module 7: Testing & Empirical Evaluation (Task 7)

DocuPulse features a 57-test hermetic unit/integration regression suite and a dedicated empirical benchmark runner evaluating ingestion, extraction, and validation accuracy against a labeled ground-truth dataset (`evaluation/ground_truth.json`).

### Empirical Benchmark Results Summary

These metrics reflect **actual measured numbers** generated by `npm run evaluate`:

| Metric Category | Measured Value | Benchmark Scope & Specification |
| :--- | :---: | :--- |
| **Document Ingestion Success Rate** | **100.0%** | All 10 benchmark documents were handled; the corrupt file was isolated |
| **Validation Status Concordance** | **90.0%** | 9 of 10 statuses matched ground truth; the image invoice needs configured OCR |
| **Overall Field Extraction Accuracy** | **87.7%** | 71 of 81 field evaluations exactly matched ground truth |
| **OCR Ground-Truth Field Accuracy** | **0% (0/9)** | OCR provider is not configured; no image invoice values were inferred |
| **Mean Processing Latency** | **85 ms** | Measured wall-clock time per document (min: 1 ms, max: 249 ms, p95: 249 ms) |
| **Automated Unit & Integration Tests** | **57 / 57 PASS** | Modules 1–5; offline test suite |

### Field-Level Extraction Accuracy

| Field Name | Evaluated Instances | Exact Matches | Measured Accuracy |
| :--- | :---: | :---: | :---: |
| `invoice_number` | 9 | 8 | **88.9%** |
| `invoice_date` | 9 | 8 | **88.9%** |
| `supplier_name` | 9 | 8 | **88.9%** |
| `customer_name` | 9 | 8 | **88.9%** |
| `subtotal` | 9 | 8 | **88.9%** |
| `tax` | 9 | 8 | **88.9%** |
| `total` | 9 | 8 | **88.9%** |
| `currency` | 9 | 7 | **77.8%** |
| `line_items_count` | 9 | 8 | **88.9%** |

*The benchmark ran in deterministic mock mode on this Windows/Node.js environment. The image fixture contributes nine misses because OCR is unavailable; its expected `valid` status therefore differs from the observed `needs_review`. Live Gemini/Vertex authentication was not verified because this environment has no configured credentials.*

*Note: Complete evaluation methodology, sample breakdowns, and failure taxonomy are documented in [`docs/evaluation_report.md`](docs/evaluation_report.md) and machine-readable [`docs/evaluation_metrics.json`](docs/evaluation_metrics.json).*

---

## Assessment Deliverables Matrix

The project includes artifacts for the listed assessment deliverables. Refer to the measured results and explicit limitations above when evaluating runtime/provider-dependent capabilities:

| Deliverable | Required Component | Primary File / Artifact | Status |
| :---: | :--- | :--- | :---: |
| **1** | Source Code | `src/`, `schemas/`, `database/`, `server.ts` | **Complete** |
| **2** | README & Setup Instructions | `README.md` | **Complete** |
| **3** | Architecture Diagram & Database Schema | [`docs/architecture_and_schema.md`](docs/architecture_and_schema.md) | **Complete** |
| **4** | Working Backend & Frontend | Express (`server.ts`, port 3000) & React 19 SPA (`src/App.tsx`) | **Complete** |
| **5** | Multi-Format Document Processing | `src/services/document/` (PDF, Image, TIFF, XLSX, XLS, CSV) | **Complete** |
| **6** | Automated Tests (52 Tests) | `scripts/run-tests.ts`, `src/services/*/tests.ts` | **Complete (52/52 PASS)** |
| **7** | Evaluation Report & Benchmark Metrics | [`docs/evaluation_report.md`](docs/evaluation_report.md) & [`docs/evaluation_metrics.json`](docs/evaluation_metrics.json) | **Complete** |
| **8** | Walkthrough Guide & Recording Script | [`docs/walkthrough_guide.md`](docs/walkthrough_guide.md) | **Complete** |
| **9** | AI Prompts & Disclosure of AI Assistance | `src/services/extraction/prompts.ts` & Section below | **Complete** |

---

## Disclosure of AI-Assisted Development

In adherence to academic integrity and technical assessment disclosure requirements:
- **AI Tooling Utilized:** Google AI Studio Build (Powered by Gemini models) was used as an interactive AI engineering partner for architectural synthesis, rapid prototyping, and drafting boilerplate schemas.
- **Human Leadership & Engineering Control:** All architectural designs, financial reconciliation algorithms (decimal-safe integer cents), security sanitization controls (bounds checking, path traversal defenses), concurrency locking mechanisms, and empirical test evaluations were directed, reviewed, and audited under senior software engineering standards.
- **Model Inferences in App Execution:** The application's runtime information extraction module utilizes isolated system instructions defined in `src/services/extraction/prompts.ts` (`INVOICE_EXTRACTION_SYSTEM_INSTRUCTION`). When running offline or in CI/CD environments, the system defaults to the deterministic `MockRuleBasedAdapter` to guarantee zero-cost, zero-hallucination execution.

---

## Development, Testing & Evaluation Commands

```bash
# 1. Run the full-stack development server (Express API on port 3000 + React SPA)
npm run dev

# 2. Run the 57-test automated regression suite
npm run test

# 3. Run the empirical benchmark evaluation on the labeled ground-truth dataset
npm run evaluate

# 4. Run the benchmark with live Gemini 3.8 Flash (requires GEMINI_API_KEY in .env)
npm run evaluate:gemini

# 5. Type-check and verify production build
npm run lint
npm run build
```
# DocuPulse---AI-Document-Intelligence-System
