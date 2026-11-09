import 'dotenv/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateDatasetFiles } from '../evaluation/generate_dataset.ts';
import { documentPipeline } from '../src/services/document/documentPipeline.ts';
import { OCR_LOW_CONFIDENCE_THRESHOLD, ocrService } from '../src/services/document/ocrService.ts';
import { ExtractionFactory } from '../src/services/extraction/llmAdapter.ts';
import { InvoiceExtractionResult } from '../src/services/extraction/schemas.ts';
import { ValidationService } from '../src/services/validation/validationService.ts';

interface GroundTruthItem {
  id: string;
  filename: string;
  file_type: string;
  is_corrupt: boolean;
  ground_truth: {
    invoice_number: string | null;
    invoice_date: string | null;
    supplier_name: string | null;
    customer_name: string | null;
    subtotal: number | null;
    tax: number | null;
    total: number | null;
    currency: string | null;
    line_items_count: number;
  };
  expected_validation_status: string;
}

interface FieldCounter {
  total: number;
  correct: number;
}

const fieldNames = [
  'invoice_number',
  'invoice_date',
  'supplier_name',
  'customer_name',
  'subtotal',
  'tax',
  'total',
  'currency',
  'line_items_count',
] as const;

function isEqual(expected: unknown, actual: unknown): boolean {
  if (expected === null) return actual === null || actual === undefined || actual === '';
  if (typeof expected === 'number' && typeof actual === 'number') {
    return Math.abs(expected - actual) < 0.01;
  }
  if (typeof expected === 'string' && typeof actual === 'string') {
    return expected.trim().toLowerCase() === actual.trim().toLowerCase();
  }
  return expected === actual;
}

function percent(counter: FieldCounter): number | null {
  return counter.total === 0 ? null : Math.round((counter.correct / counter.total) * 1_000) / 10;
}

async function main(): Promise<void> {
  await generateDatasetFiles();
  process.env.OCR_PROVIDER = 'tesseract';
  process.env.EXTRACTION_MODE = 'mock';

  const groundTruthPath = path.resolve('evaluation/ground_truth.json');
  const datasetDirectory = path.resolve('evaluation/dataset');
  const items = JSON.parse(fs.readFileSync(groundTruthPath, 'utf8')) as GroundTruthItem[];
  const adapter = ExtractionFactory.createAdapter(true);
  const fieldCounters = Object.fromEntries(fieldNames.map(name => [name, { total: 0, correct: 0 }])) as
    Record<typeof fieldNames[number], FieldCounter>;
  const ocrFieldCounters = Object.fromEntries(
    fieldNames.map(name => [name, { total: 0, correct: 0 }])
  ) as Record<typeof fieldNames[number], FieldCounter>;
  const byType = new Map<string, { documents: number; correctFields: number; totalFields: number }>();
  const confidenceValues: number[] = [];
  const priorInvoices: InvoiceExtractionResult[] = [];
  let lowQualityPageCount = 0;
  let concordantStatuses = 0;
  let evaluatedStatuses = 0;
  const documentResults: Array<Record<string, unknown>> = [];
  const startedAt = performance.now();

  try {
    for (const item of items) {
      const filePath = path.join(datasetDirectory, item.filename);
      if (!fs.existsSync(filePath)) throw new Error(`Evaluation fixture is missing: ${filePath}`);
      const input = fs.readFileSync(filePath);
      const progressUpdates: number[] = [];
      const processed = await documentPipeline.processSingleFile({
        name: item.filename,
        size: input.length,
        data: input,
      }, update => progressUpdates.push(update.progress));
      const pageResults = processed.pages || [];
      const ocrPages = pageResults.filter(page => page.isOcr);
      for (const page of ocrPages) {
        if (typeof page.confidence === 'number') confidenceValues.push(page.confidence);
        if (page.isLowQuality) lowQualityPageCount++;
      }

      let extraction: InvoiceExtractionResult | null = null;
      let validationStatus: string | null = null;
      if (processed.status !== 'failed' && !item.is_corrupt) {
        extraction = await adapter.extract(processed.rawText);
        const validation = ValidationService.validateInvoice(extraction, priorInvoices);
        validationStatus = validation.status;
        priorInvoices.push(extraction);
      } else if (item.is_corrupt) {
        validationStatus = 'failed';
      }

      const matchedFields: Record<string, boolean> = {};
      let documentCorrectFields = 0;
      let documentTotalFields = 0;
      for (const field of fieldNames) {
        if (item.is_corrupt) continue;
        const expected = item.ground_truth[field];
        const actual = field === 'line_items_count'
          ? extraction?.line_items?.length ?? 0
          : extraction?.[field];
        const matched = isEqual(expected, actual);
        matchedFields[field] = matched;
        fieldCounters[field].total++;
        documentTotalFields++;
        if (matched) {
          fieldCounters[field].correct++;
          documentCorrectFields++;
        }
        if (item.file_type === 'image' || item.file_type === 'scanned_pdf') {
          ocrFieldCounters[field].total++;
          if (matched) ocrFieldCounters[field].correct++;
        }
      }

      const typeStats = byType.get(item.file_type) || { documents: 0, correctFields: 0, totalFields: 0 };
      typeStats.documents++;
      typeStats.correctFields += documentCorrectFields;
      typeStats.totalFields += documentTotalFields;
      byType.set(item.file_type, typeStats);
      if (validationStatus !== null) {
        evaluatedStatuses++;
        if (validationStatus === item.expected_validation_status) concordantStatuses++;
      }

      const textAvailable = ocrPages.some(page =>
        page.text.trim().length > 0 && !page.text.includes('[OCR TEXT UNAVAILABLE]')
      );
      documentResults.push({
        id: item.id,
        filename: item.filename,
        file_type: item.file_type,
        pipeline_status: processed.status,
        validation_status: validationStatus,
        expected_validation_status: item.expected_validation_status,
        status_concordant: validationStatus === null ? null : validationStatus === item.expected_validation_status,
        ocr_page_count: ocrPages.length,
        ocr_text_available: ocrPages.length === 0 ? null : textAvailable,
        ocr_confidences: ocrPages.map(page => page.confidence ?? null),
        low_quality_pages: ocrPages.filter(page => page.isLowQuality).map(page => page.pageNumber),
        page_progress_updates: progressUpdates,
        field_matches: matchedFields,
        processing_warnings: processed.warnings,
        processing_errors: processed.errors,
      });
    }
  } finally {
    await ocrService.close();
  }

  const totalCounters = fieldNames.reduce<FieldCounter>(
    (total, field) => ({
      total: total.total + fieldCounters[field].total,
      correct: total.correct + fieldCounters[field].correct,
    }),
    { total: 0, correct: 0 }
  );
  const ocrTotalCounters = fieldNames.reduce<FieldCounter>(
    (total, field) => ({
      total: total.total + ocrFieldCounters[field].total,
      correct: total.correct + ocrFieldCounters[field].correct,
    }),
    { total: 0, correct: 0 }
  );
  const ocrDocumentResults = documentResults.filter(result =>
    result.file_type === 'image' || result.file_type === 'scanned_pdf'
  );
  const ocrDocumentsWithText = ocrDocumentResults.filter(result => result.ocr_text_available === true).length;
  const durationMs = Math.round(performance.now() - startedAt);
  const metrics = {
    evaluation: {
      command: 'npm run evaluate:v2',
      timestamp: new Date().toISOString(),
      node: process.version,
      platform: `${os.platform()}-${os.arch()}`,
      extraction_mode: 'mock deterministic rule parser',
      ocr_provider: process.env.OCR_PROVIDER,
      ocr_fallback: 'disabled',
      ocr_low_confidence_threshold: OCR_LOW_CONFIDENCE_THRESHOLD,
      dataset_documents: items.length,
      duration_ms: durationMs,
    },
    summary: {
      overall_field_accuracy: percent(totalCounters),
      overall_exact_field_matches: totalCounters.correct,
      overall_fields_evaluated: totalCounters.total,
      ocr_field_accuracy: percent(ocrTotalCounters),
      ocr_exact_field_matches: ocrTotalCounters.correct,
      ocr_fields_evaluated: ocrTotalCounters.total,
      ocr_documents_with_text: ocrDocumentsWithText,
      ocr_documents_evaluated: ocrDocumentResults.length,
      average_measured_tesseract_confidence: confidenceValues.length
        ? Math.round((confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length) * 1_000) / 1_000
        : null,
      measured_ocr_pages: confidenceValues.length,
      low_quality_ocr_pages: lowQualityPageCount,
      validation_status_concordance: evaluatedStatuses
        ? Math.round((concordantStatuses / evaluatedStatuses) * 1_000) / 10
        : null,
      validation_statuses_concordant: concordantStatuses,
      validation_statuses_evaluated: evaluatedStatuses,
      processing_duration_ms: durationMs,
    },
    fields: Object.fromEntries(fieldNames.map(field => [field, {
      exact_matches: fieldCounters[field].correct,
      evaluated: fieldCounters[field].total,
      accuracy_percentage: percent(fieldCounters[field]),
    }])),
    ocr_fields: Object.fromEntries(fieldNames.map(field => [field, {
      exact_matches: ocrFieldCounters[field].correct,
      evaluated: ocrFieldCounters[field].total,
      accuracy_percentage: percent(ocrFieldCounters[field]),
    }])),
    document_types: Object.fromEntries([...byType].map(([fileType, stats]) => [fileType, {
      ...stats,
      field_accuracy_percentage: stats.totalFields
        ? Math.round((stats.correctFields / stats.totalFields) * 1_000) / 10
        : null,
    }])),
    documents: documentResults,
  };

  const docsDirectory = path.resolve('docs');
  fs.mkdirSync(docsDirectory, { recursive: true });
  const metricsPath = path.join(docsDirectory, 'evaluation_metrics_v2.json');
  fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2), 'utf8');

  const documentTable = documentResults.map(result =>
    `| ${result.id} | ${result.file_type} | ${result.pipeline_status} | ` +
    `${result.ocr_page_count} | ${result.ocr_text_available ?? 'n/a'} |`
  ).join('\n');
  const typeTable = [...byType].map(([fileType, stats]) =>
    `| ${fileType} | ${stats.documents} | ${stats.correctFields}/${stats.totalFields} | ` +
    `${stats.totalFields ? `${Math.round((stats.correctFields / stats.totalFields) * 1_000) / 10}%` : 'n/a'} |`
  ).join('\n');
  const report = `# DocuPulse OCR Evaluation v2

**Measured at:** ${metrics.evaluation.timestamp}  
**Command:** \`npm run evaluate:v2\`  
**Dataset:** ${items.length} generated, labeled documents  
**Runtime:** Node ${process.version} on ${os.platform()}-${os.arch()}  
**OCR:** Local Tesseract.js; Gemini fallback disabled  
**Extraction:** Deterministic rule parser  
**Confidence review threshold:** ${Math.round(OCR_LOW_CONFIDENCE_THRESHOLD * 100)}%

This report is generated from the command run above. String fields require exact case-insensitive matches after trimming; numeric fields allow an absolute difference below 0.01. No substring matching is used. It measures this generated dataset only and is not a production accuracy guarantee.

## Results

| Metric | Measured result |
|---|---:|
| Overall field accuracy | ${metrics.summary.overall_exact_field_matches}/${metrics.summary.overall_fields_evaluated} (${metrics.summary.overall_field_accuracy}%) |
| OCR field accuracy (image + scanned PDF) | ${metrics.summary.ocr_exact_field_matches}/${metrics.summary.ocr_fields_evaluated} (${metrics.summary.ocr_field_accuracy}%) |
| OCR documents with non-empty transcript | ${ocrDocumentsWithText}/${ocrDocumentResults.length} |
| Mean measured Tesseract page confidence | ${metrics.summary.average_measured_tesseract_confidence ?? 'not measured'} |
| OCR pages with measured confidence | ${metrics.summary.measured_ocr_pages} |
| Pages flagged below threshold | ${metrics.summary.low_quality_ocr_pages} |
| Validation status concordance | ${metrics.summary.validation_statuses_concordant}/${metrics.summary.validation_statuses_evaluated} (${metrics.summary.validation_status_concordance}%) |
| Processing duration | ${durationMs} ms |

### Results by document type

| Type | Documents | Exact fields | Accuracy |
|---|---:|---:|---:|
${typeTable}

### OCR field matches

| Field | Exact matches | Evaluated | Accuracy |
|---|---:|---:|---:|
${fieldNames.map(field =>
  `| \`${field}\` | ${ocrFieldCounters[field].correct} | ${ocrFieldCounters[field].total} | ${percent(ocrFieldCounters[field]) ?? 'n/a'}% |`
).join('\n')}

### Document processing

| ID | Type | Pipeline status | OCR pages | OCR text available |
|---|---|---|---:|---|
${documentTable}

Per-page Tesseract confidences, page progress, warnings, and field-level comparisons are in [evaluation_metrics_v2.json](./evaluation_metrics_v2.json). Confidence values are the raw Tesseract page confidence normalized to [0, 1]; Gemini confidence is not included.
`;
  const reportPath = path.join(docsDirectory, 'evaluation_report_v2.md');
  fs.writeFileSync(reportPath, report, 'utf8');

  console.log('DocuPulse local OCR evaluation v2');
  console.log(`Command: npm run evaluate:v2`);
  console.log(`Dataset: ${items.length} documents (${[...byType.keys()].join(', ')})`);
  console.log(`Overall field accuracy: ${totalCounters.correct}/${totalCounters.total} (${metrics.summary.overall_field_accuracy}%)`);
  console.log(`OCR field accuracy: ${ocrTotalCounters.correct}/${ocrTotalCounters.total} (${metrics.summary.ocr_field_accuracy}%)`);
  console.log(`OCR documents with text: ${ocrDocumentsWithText}/${ocrDocumentResults.length}`);
  console.log(`Measured OCR pages: ${metrics.summary.measured_ocr_pages}; low quality: ${lowQualityPageCount}`);
  console.log(`Mean measured Tesseract confidence: ${metrics.summary.average_measured_tesseract_confidence ?? 'not measured'}`);
  console.log(`Validation concordance: ${concordantStatuses}/${evaluatedStatuses} (${metrics.summary.validation_status_concordance}%)`);
  console.log(`Duration: ${durationMs} ms`);
  console.log(`Metrics saved: ${metricsPath}`);
  console.log(`Report saved: ${reportPath}`);
}

main().catch(error => {
  console.error('OCR evaluation v2 failed:', error);
  process.exitCode = 1;
});
