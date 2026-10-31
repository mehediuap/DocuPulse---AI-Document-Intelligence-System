# DocuPulse — Empirical Evaluation & Performance Report

**System:** DocuPulse — AI-Powered Document Intelligence System
**Evaluation timestamp:** `2026-10-31T11:19:26.786Z`
**Evaluation mode:** Offline deterministic rule-based adapter
**Dataset:** 10 labeled documents in `evaluation/dataset`

This report mirrors the machine-readable results in [evaluation_metrics.json](./evaluation_metrics.json). The benchmark was run with `npm run evaluate`; it measures ingestion, extraction, validation, and processing latency. The OCR provider was disabled for this offline run.

## 1. Results summary

| Metric | Measured result |
|---|---:|
| Documents handled | 10/10 (100%) |
| Validation status concordance | 9/9 comparable (100%); 1 inconclusive |
| Overall field extraction accuracy | 72/81 (88.9%) |
| OCR ground-truth field accuracy | 0/9 (0%); provider not configured |
| Minimum / median / mean latency | 0 / 13 / 189 ms |
| p95 / maximum latency | 1,405 / 1,405 ms |
| Sum of per-document latencies | 1,887 ms |
| Regression tests | 71/71 passing |

The PNG fixture has expected status `valid`, but its OCR text is unavailable in this offline benchmark. Its status comparison is therefore marked inconclusive rather than counted as a validation mismatch. A regression test supplies an OCR transcript for this fixture and confirms the resulting invoice validates as `valid`.

## 2. Evaluation environment

| Property | Measured value |
|---|---|
| Node.js | `v24.13.0` |
| Platform / architecture | `win32` / `x64` |
| CPU count | 4 |
| System memory | 11.8 GB |
| Extraction adapter | `mock` (`deterministic_rule_parser`) |
| Sample size | 10 |

## 3. Dataset and expected validation status

| ID | Format | Evaluation case | Expected status |
|---|---|---|---|
| DOC-EVAL-001 | PDF | Complete single-page invoice | `valid` |
| DOC-EVAL-002 | PDF | Two-page invoice | `valid` |
| DOC-EVAL-003 | CSV | RFC-4180 comma-delimited invoice | `valid` |
| DOC-EVAL-004 | XLSX | Multi-sheet invoice | `valid` |
| DOC-EVAL-005 | PNG | Raster invoice requiring OCR | `valid` |
| DOC-EVAL-006 | CSV | Semicolon-delimited EUR invoice | `valid` |
| DOC-EVAL-007 | PDF | Missing critical subtotal, customer, and currency | `invalid` |
| DOC-EVAL-008 | XLSX | Intentional subtotal/tax/total mismatch | `invalid` |
| DOC-EVAL-009 | CSV | Duplicate invoice candidate | `needs_review` |
| DOC-EVAL-010 | PDF | Corrupt payload | `failed` |

## 4. Field-level extraction accuracy

Each field was evaluated on the 9 non-corrupt documents. The offline OCR-disabled PNG contributes a miss for each expected field.

| Field | Exact matches | Evaluated | Accuracy |
|---|---:|---:|---:|
| `invoice_number` | 8 | 9 | 88.9% |
| `invoice_date` | 8 | 9 | 88.9% |
| `supplier_name` | 8 | 9 | 88.9% |
| `customer_name` | 8 | 9 | 88.9% |
| `subtotal` | 8 | 9 | 88.9% |
| `tax` | 8 | 9 | 88.9% |
| `total` | 8 | 9 | 88.9% |
| `currency` | 8 | 9 | 88.9% |
| `line_items_count` | 8 | 9 | 88.9% |
| **Overall** | **72** | **81** | **88.9%** |

## 5. Latency

Latencies cover document ingestion, parsing, extraction, and validation, measured per document with `performance.now()`.

| Statistic | Duration |
|---|---:|
| Minimum | 0 ms |
| Median | 13 ms |
| Mean | 189 ms |
| p95 | 1,405 ms |
| Maximum | 1,405 ms |
| Sum of per-document measurements | 1,887 ms |

## 6. Validation and OCR observations

- The corrupt PDF is isolated as `failed`; it does not prevent the remaining documents from being processed.
- The missing critical subtotal in DOC-EVAL-007 routes it to `invalid`, consistent with the validation rule for missing critical amounts. The fixture’s missing currency is represented as `null` in ground truth.
- The intentional arithmetic mismatch in DOC-EVAL-008 routes to `invalid`.
- The duplicate candidate in DOC-EVAL-009 routes to `needs_review`.
- OCR was not configured for this benchmark, so the PNG OCR accuracy is 0/9 and its validation-status comparison is inconclusive. This does not measure live OCR quality.
- Regression tests verify that Gemini OCR errors on scanned PDF pages fall back to Tesseract and that a valid OCR transcript for the PNG invoice passes financial validation.
- Live Gemini/Vertex AI service accuracy and availability were not measured.
