# DocuPulse OCR Evaluation v2

**Measured at:** 2026-11-05T07:25:05.342Z  
**Command:** `npm run evaluate:v2`  
**Dataset:** 11 generated, labeled documents  
**Runtime:** Node v24.13.0 on win32-x64  
**OCR:** Local Tesseract.js; Gemini fallback disabled  
**Extraction:** Deterministic rule parser  
**Confidence review threshold:** 65%

This report is generated from the command run above. String fields require exact case-insensitive matches after trimming; numeric fields allow an absolute difference below 0.01. No substring matching is used. It measures this generated dataset only and is not a production accuracy guarantee.

## Results

| Metric | Measured result |
|---|---:|
| Overall field accuracy | 90/90 (100%) |
| OCR field accuracy (image + scanned PDF) | 18/18 (100%) |
| OCR documents with non-empty transcript | 2/2 |
| Mean measured Tesseract page confidence | 0.94 |
| OCR pages with measured confidence | 2 |
| Pages flagged below threshold | 0 |
| Validation status concordance | 11/11 (100%) |
| Processing duration | 31745 ms |

### Results by document type

| Type | Documents | Exact fields | Accuracy |
|---|---:|---:|---:|
| pdf | 4 | 27/27 | 100% |
| csv | 3 | 27/27 | 100% |
| xlsx | 2 | 18/18 | 100% |
| image | 1 | 9/9 | 100% |
| scanned_pdf | 1 | 9/9 | 100% |

### OCR field matches

| Field | Exact matches | Evaluated | Accuracy |
|---|---:|---:|---:|
| `invoice_number` | 2 | 2 | 100% |
| `invoice_date` | 2 | 2 | 100% |
| `supplier_name` | 2 | 2 | 100% |
| `customer_name` | 2 | 2 | 100% |
| `subtotal` | 2 | 2 | 100% |
| `tax` | 2 | 2 | 100% |
| `total` | 2 | 2 | 100% |
| `currency` | 2 | 2 | 100% |
| `line_items_count` | 2 | 2 | 100% |

### Document processing

| ID | Type | Pipeline status | OCR pages | OCR text available |
|---|---|---|---:|---|
| DOC-EVAL-001 | pdf | completed | 0 | n/a |
| DOC-EVAL-002 | pdf | completed | 0 | n/a |
| DOC-EVAL-003 | csv | warning | 0 | n/a |
| DOC-EVAL-004 | xlsx | warning | 0 | n/a |
| DOC-EVAL-005 | image | completed | 1 | true |
| DOC-EVAL-006 | csv | warning | 0 | n/a |
| DOC-EVAL-007 | pdf | completed | 0 | n/a |
| DOC-EVAL-008 | xlsx | warning | 0 | n/a |
| DOC-EVAL-009 | csv | warning | 0 | n/a |
| DOC-EVAL-010 | pdf | failed | 0 | n/a |
| DOC-EVAL-011 | scanned_pdf | warning | 1 | true |

Per-page Tesseract confidences, page progress, warnings, and field-level comparisons are in [evaluation_metrics_v2.json](./evaluation_metrics_v2.json). Confidence values are the raw Tesseract page confidence normalized to [0, 1]; Gemini confidence is not included.
