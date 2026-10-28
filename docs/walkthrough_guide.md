# DocuPulse — Video Walkthrough & Technical Demonstration Guide

**Project Name:** DocuPulse — AI-Powered Document Intelligence System  
**Role:** Senior AI Engineer Assessment Submission  
**Target Audience:** Assessment Evaluators & Technical Leadership  
**Target Video Duration:** 4–7 Minutes  

---

## 1. Walkthrough Agenda & Time Allocations

| Section | Topic | Screen Focus | Target Duration |
| :---: | :--- | :--- | :---: |
| **1** | Introduction & Problem Space | Frontend Dashboard & System Architecture | 0:45 |
| **2** | Ingestion & Multi-Format Processing | Multi-File Dropzone & Demo Fixtures Drawer | 1:00 |
| **3** | AI Extraction & Validation Rules | Document Detail Inspector Modal | 1:15 |
| **4** | Manual Corrections & Audit Trail | Auditor Editing Tab & Audit Log Modal | 0:45 |
| **5** | Backend REST API & Background Queue | Terminal / OpenAPI Docs (`/api/v1/openapi.json`) | 0:45 |
| **6** | Persistence, Search & Decimal Safety | Database Schema & Keyword Search Filter | 0:45 |
| **7** | Automated Tests & Empirical Evaluation | CLI Runner (`npm run test` & `npm run evaluate`) | 1:00 |
| **8** | Conclusion & AI Disclosure | Architecture Summary & Disclosure Section | 0:30 |

---

## 2. Step-by-Step Demonstration Script

### Section 1: Introduction (0:00 – 0:45)
- **Visual:** Open browser to the DocuPulse dashboard (`http://localhost:3000`).
- **Narrative:**
  > "Hello everyone. Today I'm presenting **DocuPulse**, an enterprise-grade AI-powered document intelligence system built for end-to-end invoice ingestion, multimodal LLM information extraction, mathematical reconciliation, and audit management.
  > The system addresses a critical enterprise problem: businesses receive documents in chaotic varieties—digital PDFs, scanned receipts, multi-sheet Excel workbooks, and CSV files—often containing subtle arithmetic errors, duplicate billing collisions, or missing required fields.
  > DocuPulse unifies 7 core modules into a single production-ready application featuring a React 19 frontend, an asynchronous Express REST API, a decimal-safe relational database, and empirical test harnesses."

---

### Section 2: Ingestion & Multi-Format Processing (0:45 – 1:45)
- **Visual:** Hover over the **Multi-File Upload Dropzone** and open the **Sample Test Documents Drawer**.
- **Actions:**
  1. Click **Compliant Invoice (PDF)** to inject a digital PDF.
  2. Click **Multi-Sheet Workbook (XLSX)** to inject an OpenXML spreadsheet.
  3. Click **Semicolon European (CSV)** to demonstrate delimiter auto-detection.
  4. Click **Math Discrepancy (XLSX)** and **Corrupted File (Payload)**.
- **Narrative:**
  > "Let's begin with Module 1: Document Processing. The system accepts 7 distinct media formats: digital and scanned PDFs, raster images like PNG and JPEG, multi-page TIFFs, modern Excel workbooks, legacy BIFF8 spreadsheets, and CSV exports.
  > Notice the drag-and-drop dropzone with pre-flight bounds validation that rejects oversized payloads and empty 0-byte files.
  > When I load these sample files, notice how the batch pipeline guarantees **fault-isolation**: even though this corrupted payload was injected, it is caught safely without crashing the batch or interrupting other documents."

---

### Section 3: AI Information Extraction & Validation (1:45 – 3:00)
- **Visual:** Observe the documents appearing in the **Documents Table**. Click on `INV-2026-001-ApexCloud.pdf` to open the **Document Detail Inspector Modal**.
- **Actions:**
  1. Inspect the **Extracted Information Tab**: Show extracted `Invoice #`, `Date`, `Supplier Name`, `Customer Name`, `Subtotal`, `Tax`, `Total`, `Currency`, and the itemized **Line Items** table.
  2. Switch to the **Validation & Rules Tab**: Highlight the financial balance reconciliation card (Subtotal + Tax vs Stated Total with discrepancy delta).
  3. Close modal, then open the **Math Discrepancy** document to show the red `invalid` banner and the `ARITHMETIC_TOTAL_MISMATCH` issue badge.
- **Narrative:**
  > "Here in Module 2 and Module 3, DocuPulse transforms raw document text into validated, schema-compliant JSON structures.
  > We support two extraction adapters: our hermetic, deterministic rule-based adapter for zero-cost offline testing, and our Gemini 3.8 Flash multimodal adapter using `@google/genai`.
  > Notice that missing fields are strictly preserved as `null` rather than hallucinated.
  > In the Validation tab, our financial engine applies decimal-safe integer cents arithmetic to prevent IEEE-754 precision drift. For this clean invoice, Subtotal plus Tax matches the Stated Total within our configurable five-cent rounding tolerance.
  > When we inspect this mathematical mismatch invoice, the system immediately flags `ARITHMETIC_TOTAL_MISMATCH` because 2,000 subtotal plus 200 tax equals 2,200, whereas the invoice stated 2,450. The document is flagged `invalid` and quarantined from automatic posting."

---

### Section 4: Manual Corrections & Audit Trail (3:00 – 3:45)
- **Visual:** In the modal for the flagged invoice, click on the **Manual Corrections Tab**.
- **Actions:**
  1. Select `total` in the field dropdown.
  2. Enter the corrected total (`2200.00`).
  3. Enter the reason: `"Reconciled total with subtotal and tax per purchase order agreement."`
  4. Click **Apply Correction & Revalidate**.
  5. Switch to the **Audit Trail Tab** to inspect the recorded audit log.
- **Narrative:**
  > "In Module 4, DocuPulse provides a human-in-the-loop audit interface. Auditors can select any field, provide the corrected value, and input a mandatory business justification.
  > When I submit this correction, the backend immediately applies the change, re-runs the validation engine, updates the document status from `invalid` to `valid`, and writes an immutable record to the `audit_trail` table capturing the timestamp, author, previous value, and reason."

---

### Section 5: Backend REST API & Job Queue (3:45 – 4:30)
- **Visual:** Open browser tab to `/api/v1/openapi.json` or show terminal `curl` calls.
- **Narrative:**
  > "The backend REST API is built on Express running on port 3000 with clean `/api/v1` routing.
  > Long-running OCR and AI inference operations execute through an asynchronous background queue abstraction. When documents are uploaded, the client receives an immediate `202 Accepted` response with processing job references.
  > The system includes a concurrency lock manager that prevents duplicate race conditions if `/retry` is called while a document is currently processing.
  > The OpenAPI 3.0 specification is hosted live at `/api/v1/openapi.json` and documents all request schemas, response models, and error states."

---

### Section 6: Database, Search & Decimal Safety (4:30 – 5:15)
- **Visual:** Return to the dashboard. Type `"Apex"` in the keyword search box; then filter by status `"completed"`.
- **Narrative:**
  > "In Module 5, DocuPulse uses a persistent relational storage layer. The application runs on SQLite in Write-Ahead Logging (`WAL`) mode via `better-sqlite3`, and includes declarative SQLAlchemy models in `database/models.py` allowing a zero-code-change path to PostgreSQL.
  > To support high-throughput operations, we have composite indexes on `(status)`, `(file_type)`, and an indexed composite key on `(supplier_name, invoice_number)` for sub-millisecond duplicate invoice collision detection.
  > Notice the keyword search bar: it searches across raw text streams, supplier names, and invoice numbers simultaneously.
  > Furthermore, for semantic search: when embedding credentials are unconfigured, DocuPulse transparently returns a fallback notice rather than misrepresenting keyword matches as vector embeddings."

---

### Section 7: Automated Tests & Empirical Evaluation (5:15 – 6:15)
- **Visual:** Switch to the terminal. Run `npm run test`, then run `npm run evaluate`.
- **Actions:**
  1. Run `npm test`. Show all 57 tests passing across Modules 1–5.
  2. Run `npm run evaluate`. Show the empirical benchmark table.
- **Narrative:**
  > "Now let's examine the automated test suite and empirical evaluation.
  > When I execute `npm test`, our test runner executes 57 hermetic automated tests covering:
  > - Native digital PDF parsing and layout preservation
  > - Scanned image dimension extraction and OCR fallbacks
  > - Multi-worksheet XLSX and legacy XLS BIFF8 parsing
  > - RFC-4180 CSV auto-delimitation
  > - Strict null handling and schema validation
  > - Decimal-safe financial reconciliation and duplicate detection
  > - REST API endpoints, background queue locks, and database persistence
  > All 57 tests pass with 0 failures.
  > Next, let's run `npm run evaluate`. This runs our benchmark runner against our 10-document ground-truth dataset in `evaluation/`.
  > As you can see from the actual measured output:
  > - Document Ingestion Success Rate: **100.0%**
  > - Validation Status Concordance: **90.0%**
  > - Overall Field Extraction Accuracy: **87.7%**
  > - OCR Ground-Truth Field Accuracy: **0%** because no OCR provider is configured.
  > - Mean processing latency in the recorded run: **85 milliseconds** per document.
  > All metrics are saved to `docs/evaluation_metrics.json` and documented in `docs/evaluation_report.md`."

---

### Section 8: Conclusion & AI Disclosure (6:15 – 6:45)
- **Visual:** Return to the README.md or project overview.
- **Narrative:**
  > "In summary, DocuPulse fulfills all seven modules of the Senior AI Engineer assessment. It provides a robust, decoupled architecture combining resilient multi-format document parsing, grounded AI extraction, decimal-safe accounting validation, a production REST API, persistent relational storage, an accessible React dashboard, and empirical evaluation.
  > In accordance with assessment instructions, full disclosure of AI-assisted development tools and prompt engineering practices is documented in `README.md` and `docs/`.
  > Thank you very much for your time and review."

---

## 3. Preparation Checklist for Video Recording

- [x] Full-stack development server running (`npm run dev` on port 3000).
- [x] Verify database initialized and clean (`docupulse.db`).
- [x] Automated test suite verified (`npm test` -> 57/57 passing).
- [x] Evaluation benchmark verified (`npm run evaluate` -> 90% concordance, 87.7% field accuracy; OCR provider unconfigured).
- [x] Browser tabs ready:
  - Tab 1: Frontend Dashboard (`http://localhost:3000`)
  - Tab 2: OpenAPI Specification (`http://localhost:3000/api/v1/openapi.json`)
  - Tab 3: Health Status (`http://localhost:3000/health`)
- [x] Terminal split ready for CLI demonstrations (`npm run test` and `npm run evaluate`).
