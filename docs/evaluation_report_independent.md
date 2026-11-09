# Independent Dataset Evaluation

**Measured at:** 2026-11-05T12:04:59.164Z  
**Command:** `npm run evaluate:independent`  
**Dataset:** `evaluation/dataset_independent` (**27** evaluated documents; 0 skipped)  
**Ground truth:** `evaluation/ground_truth_independent.json`  
**Extraction:** deterministic rule parser  
**OCR:** Local Tesseract.js; Gemini OCR fallback disabled.

All values below were measured by this run. Strict string matching is case/punctuation-insensitive but requires the complete value; numeric tolerance is less than 0.01. The dataset is generated and is not a production accuracy guarantee.

## Summary

| Metric | Measured result |
|---|---:|
| Overall strict field accuracy | 190/216 (88%) |
| Documents with every field strictly correct | 11/24 (45.8%) |
| Invented values where ground truth is null | 0 |
| Validation status concordance | 16/27 (59.3%) |
| OCR ground-truth field accuracy | 45/45 (100%) |
| OCR pages / measured confidences | 5 / 5 |
| Mean measured Tesseract confidence | 0.914 |
| Low-quality OCR pages | 0 |
| Mean processing latency | 521 ms |

## OCR results by type

| Type | Documents | Strict exact fields | Strict accuracy | OCR text | OCR pages | Mean confidence | Low-quality pages |
|---|---:|---:|---:|---:|---:|---:|---:|
| image | 3 | 27/27 | 100% | 3 | 3 | 0.913 | 0 |
| scanned_pdf | 2 | 18/18 | 100% | 2 | 2 | 0.915 | 0 |

## Document accuracy by type

| Type | Documents | Strict exact fields | Strict accuracy |
|---|---:|---:|---:|
| pdf | 13 | 107/117 | 91.5% |
| csv | 3 | 17/27 | 63% |
| xlsx | 3 | 21/27 | 77.8% |
| image | 3 | 27/27 | 100% |
| scanned_pdf | 2 | 18/18 | 100% |

## Field-level results

| Field | Strict exact matches | Strict accuracy | Invented values |
|---|---:|---:|---:|
| invoice_number | 23/24 | 95.8% | 0 |
| invoice_date | 23/24 | 95.8% | 0 |
| supplier_name | 23/24 | 95.8% | 0 |
| customer_name | 23/24 | 95.8% | 0 |
| subtotal | 20/24 | 83.3% | 0 |
| tax | 20/24 | 83.3% | 0 |
| total | 21/24 | 87.5% | 0 |
| currency | 23/24 | 95.8% | 0 |
| line_items_count | 14/24 | 58.3% | 0 |

## Per-document results

| ID | Type | Pipeline | Validation | Strict accuracy | OCR pages | OCR text |
|---|---|---|---|---:|---:|---|
| V2-001 | pdf | completed | invalid | 88.9% | 0 | n/a |
| V2-002 | pdf | completed | invalid | 88.9% | 0 | n/a |
| V2-003 | pdf | completed | needs_review | 77.8% | 0 | n/a |
| V2-004 | pdf | completed | valid | 88.9% | 0 | n/a |
| V2-005 | pdf | completed | needs_review | 100% | 0 | n/a |
| V2-006 | pdf | completed | valid | 88.9% | 0 | n/a |
| V2-007 | pdf | completed | invalid | 100% | 0 | n/a |
| V2-008 | pdf | completed | valid | 100% | 0 | n/a |
| V2-009 | pdf | completed | needs_review | 77.8% | 0 | n/a |
| V2-010 | pdf | completed | needs_review | 88.9% | 0 | n/a |
| V2-011 | pdf | completed | invalid | 88.9% | 0 | n/a |
| V2-012 | pdf | completed | valid | 100% | 0 | n/a |
| V2-013 | pdf | completed | valid | 100% | 0 | n/a |
| V2-014 | csv | warning | invalid | 55.6% | 0 | n/a |
| V2-015 | csv | warning | needs_review | 88.9% | 0 | n/a |
| V2-016 | csv | warning | invalid | 44.4% | 0 | n/a |
| V2-017 | xlsx | completed | invalid | 55.6% | 0 | n/a |
| V2-018 | xlsx | warning | valid | 100% | 0 | n/a |
| V2-019 | xlsx | completed | invalid | 77.8% | 0 | n/a |
| V2-020 | image | completed | valid | 100% | 1 | true |
| V2-021 | image | completed | valid | 100% | 1 | true |
| V2-022 | image | completed | valid | 100% | 1 | true |
| V2-023 | scanned_pdf | warning | valid | 100% | 1 | true |
| V2-024 | scanned_pdf | warning | valid | 100% | 1 | true |
| V2-025 | pdf | failed | failed | 0% | 0 | n/a |
| V2-026 | pdf | failed | failed | 0% | 0 | n/a |
| V2-027 | pdf | failed | failed | 0% | 0 | n/a |

Per-page confidences, warnings, field comparisons, and latency details are available in [evaluation_metrics_independent.json](./evaluation_metrics_independent.json).
