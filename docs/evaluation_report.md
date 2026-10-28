# DocuPulse — Empirical Evaluation & Performance Report

**System Name:** DocuPulse — AI-Powered Document Intelligence System  
**Evaluation Date:** October 28, 2026  
**Evaluation Mode:** Hermetic Offline Benchmark (`MockRuleBasedAdapter`)  
**Assessment Deliverable:** Task 7 — Testing and Evaluation  

---

## 1. Executive Summary

This report documents the empirical evaluation of the **DocuPulse** document intelligence pipeline across ingestion, AI information extraction, and financial validation modules. All reported figures represent **actual measured outcomes** from benchmark runs executed via `npm run evaluate` against a labeled synthetic ground-truth dataset (`evaluation/ground_truth.json`). No metrics, accuracies, or latencies in this report are simulated or fabricated.

### Key Measured Highlights
- **Document Ingestion Success Rate:** **100.0%** (10 of 10 documents safely handled without unhandled exceptions or crashes; 1 corrupted binary file safely caught and isolated).
- **Validation Status Concordance:** **90.0%** (9 of 10 statuses matched ground truth; the image invoice cannot be extracted without a configured OCR provider).
- **Overall Field Extraction Accuracy:** **87.7%** (71 of 81 field evaluations matched ground truth).
- **OCR Ground-Truth Field Accuracy:** **0%** (0 of 9 fields; provider not configured, and no invoice values were inferred).
- **Mean Processing Latency:** **85 ms** per document (p95: 249 ms, min: 1 ms, max: 249 ms).
- **Automated Regression Test Suite:** **57 of 57 tests passing** (100% pass rate across Modules 1–5).

---

## 2. Evaluation Environment & Hardware

The empirical benchmark was executed under the following controlled environment:

| Property | Value |
| :--- | :--- |
| **Runtime Environment** | Node.js `v24.13.0` with TypeScript (`tsx`) |
| **Operating System** | Windows (`win32`, `x64`) |
| **Host System Architecture** | 4 logical CPUs |
| **System Memory** | 11.8 GB |
| **Database Engine** | SQLite 3 (WAL mode) via `better-sqlite3` |
| **Extraction Adapter** | `MockRuleBasedAdapter` (Offline Deterministic) |
| **Sample Size** | 10 Labeled Multi-Format Documents |

---

## 3. Labeled Synthetic Dataset Composition

The ground-truth benchmark dataset comprises 10 distinct test documents designed to evaluate edge cases, varied MIME types, tabular layouts, mathematical anomalies, and failure resilience:

| Document ID | Filename | Format | Description / Test Objective | Expected Status |
| :--- | :--- | :--- | :--- | :--- |
| `DOC-EVAL-001` | `INV-2026-001-ApexCloud.pdf` | Digital PDF | Standard single-page PDF with header, line items, and reconciled totals | `valid` |
| `DOC-EVAL-002` | `INV-2026-002-EnterpriseNetworks.pdf` | Digital PDF | Multi-page PDF spanning 2 pages (items on p1, summary on p2) | `valid` |
| `DOC-EVAL-003` | `INV-2026-003-NordicTech.csv` | RFC-4180 CSV | Comma-delimited CSV invoice export with quoted strings | `valid` |
| `DOC-EVAL-004` | `INV-2026-004-PrecisionHardware.xlsx` | OpenXML XLSX | Multi-sheet Excel workbook (Summary sheet + LineItems sheet) | `valid` |
| `DOC-EVAL-005` | `INV-2026-005-BeaconSupplies.png` | Raster PNG | Scanned receipt; OCR is unavailable without provider credentials, so extraction reports missing values and needs review | `valid` |
| `DOC-EVAL-006` | `INV-2026-006-EuroScale.csv` | Semicolon CSV | European invoice with `;` delimiter, EUR currency, and 19% VAT | `valid` |
| `DOC-EVAL-007` | `INV-2026-007-QuickPrint.pdf` | Digital PDF | Incomplete invoice: missing customer, subtotal, and unstated currency | `needs_review` |
| `DOC-EVAL-008` | `INV-2026-008-StarlightMedia.xlsx` | OpenXML XLSX | Intentional arithmetic mismatch ($2,000 subtotal + $200 tax $\neq$ $2,450 total) | `invalid` |
| `DOC-EVAL-009` | `INV-2026-009-DuplicateCandidate.csv` | RFC-4180 CSV | Duplicate collision candidate matching `DOC-EVAL-001` supplier & invoice # | `needs_review` |
| `DOC-EVAL-010` | `INV-2026-010-CorruptPayload.pdf` | Truncated Binary | Malformed/corrupted binary stream to test fault-isolation & error reporting | `failed` |

---

## 4. Measured Extraction Accuracy (Field-by-Field)

Accuracy was evaluated using **exact match criteria** (and substring/normalization equivalence where applicable) comparing extracted JSON to `ground_truth.json`. The nine non-corrupted documents contribute 81 field evaluations. Because the OCR provider is unconfigured, all nine image-fixture fields are reported as misses rather than inferred. The earlier diagnostic filename false positive is now excluded from extraction:

| Extracted Field | Evaluated Samples | Exact Matches | Empirical Accuracy | Notes |
| :--- | :---: | :---: | :---: | :--- |
| `invoice_number` | 9 | 8 | **88.9%** | Image invoice unavailable without OCR |
| `invoice_date` | 9 | 8 | **88.9%** | Image invoice unavailable without OCR |
| `supplier_name` | 9 | 8 | **88.9%** | Image invoice unavailable without OCR |
| `customer_name` | 9 | 8 | **88.9%** | Image invoice unavailable without OCR |
| `subtotal` | 9 | 8 | **88.9%** | Image invoice unavailable without OCR |
| `tax` | 9 | 8 | **88.9%** | Image invoice unavailable without OCR |
| `total` | 9 | 8 | **88.9%** | Image invoice unavailable without OCR |
| `currency` | 9 | 7 | **77.8%** | Image invoice unavailable; DOC-EVAL-007 correctly has no currency |
| `line_items_count` | 9 | 8 | **88.9%** | Image invoice unavailable without OCR |
| **System Overall** | **81** | **71** | **87.7%** | **Composite extraction accuracy across all fields** |

---

## 5. System Latency & Processing Duration

Wall-clock latencies were measured using high-resolution timers (`performance.now()`) across the end-to-end ingestion, parsing, extraction, and validation lifecycle:

| Metric | Measured Duration (ms) |
| :--- | :---: |
| **Minimum Document Latency** | 1 ms |
| **Mean Document Latency** | 85 ms |
| **Median Document Latency** | 53 ms |
| **p95 Latency** | 249 ms |
| **Maximum Document Latency** | 249 ms (OpenXML multi-sheet XLSX decompression) |
| **Total Batch Processing Time (10 files)** | 852 ms |

---

## 6. Extraction Modes & Provider Status

### Mode 1: Deterministic Rule-Based Extraction (`MockRuleBasedAdapter`)
- **Use Case:** CI/CD test automation, air-gapped environments, zero-cost regression testing.
- **Strengths:** 0 ms external network latency, 100% deterministic reproducibility, zero API costs.
- **Limitation:** Relies on standardized document patterns, tabular pipe structures, and regular expressions. Highly unstructured or novel free-form narratives require LLM reasoning.

### Live Gemini / Vertex AI extraction
- The adapter and environment configuration are implemented, but live authentication and OCR were **not tested** in this run because no Gemini API key or Vertex AI credentials were configured.
- The test suite verifies timeout and provider-failure handling with controlled test adapters; these tests do not establish live service availability or accuracy.

---

## 7. Failure Taxonomy & Resilience Audit

| Failure Category | Test Scenario | System Defense Mechanism | Actual Measured Outcome |
| :--- | :--- | :--- | :--- |
| **Empty File (0 Bytes)** | Upload 0-byte payload | Pre-flight bounds check in `security.ts` | Rejected with `400 Bad Request` / `File is empty (0 bytes)`. |
| **Corrupted Binary** | `DOC-EVAL-010-CorruptPayload.pdf` | PDF header validation & outer catch in pipeline | Batch isolates fault; document status set to `failed`; 0 crashes. |
| **Arithmetic Mismatch** | `DOC-EVAL-008-StarlightMedia.xlsx` | Decimal-safe integer cents reconciliation | Flagged `ARITHMETIC_TOTAL_MISMATCH`; status resolved to `invalid`. |
| **Missing Currency** | `DOC-EVAL-007-QuickPrint.pdf` | Rule-based currency audit | Flagged `MISSING_CURRENCY` warning; status resolved to `needs_review`. |
| **Duplicate Collision** | `DOC-EVAL-009-DuplicateCandidate.csv` | Normalized candidate lookup on supplier + invoice # | Flagged `DUPLICATE_INVOICE_CANDIDATE`; status resolved to `needs_review`. |
| **Path Traversal Attack** | Filename `../../etc/passwd.pdf` | Sanitization regex in `security.ts` | Cleaned to `passwd.pdf`; safe storage path allocated. |
| **Concurrency Collision** | Concurrent `/retry` on processing job | In-memory job lock registry | Returns `409 Conflict`; duplicate background execution prevented. |

---

## 8. Explicit Limitations & Disclosures

1. **OCR Provider Not Configured:** In this benchmark, image and scanned-PDF OCR produced an explicit unavailable-provider diagnostic and no inferred invoice values. Configure Gemini Vision or a supported OCR provider to evaluate actual OCR quality.
2. **PDF Parsing Scope:** The in-repository PDF parser handles supported plain text operators and uses heuristic page allocation; it is not a full PDF specification parser. Scanned-PDF OCR is currently submitted as a single document page.
3. **Multi-page TIFF:** IFD traversal reports frame counts, but OCR content is not yet isolated per frame; the processor emits a warning.
4. **Semantic Search Vector Credentials:** When vector embedding APIs are unconfigured, semantic search returns `fallback_unavailable` with a transparent notice rather than fabricating vector cosine scores from keyword searches.
5. **Assessment Demo Authentication:** The REST API does not enforce multi-tenant authentication or JWT validation; it is designated strictly as a local technical assessment demo.
