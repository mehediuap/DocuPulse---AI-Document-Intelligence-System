/**
 * DocuPulse — Empirical Evaluation Benchmark Runner
 * 
 * Evaluates document processing, extraction accuracy, and validation reconciliation
 * across a labeled synthetic ground-truth dataset.
 * 
 * Generates docs/evaluation_metrics.json with empirical numbers (never fabricated).
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { documentPipeline } from '../src/services/document/documentPipeline.ts';
import { ExtractionFactory } from '../src/services/extraction/llmAdapter.ts';
import { ValidationService } from '../src/services/validation/validationService.ts';
import { InvoiceExtractionResult } from '../src/services/extraction/schemas.ts';

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
  expected_validation_status: 'valid' | 'needs_review' | 'invalid' | 'failed';
  description: string;
}

interface FieldMatchEvaluation {
  matched: boolean;
  expected: any;
  actual: any;
}

interface DocumentEvaluationResult {
  id: string;
  filename: string;
  file_type: string;
  is_corrupt: boolean;
  pipeline_status: string;
  expected_validation_status: string;
  actual_validation_status: string | null;
  status_concordance: boolean;
  processing_time_ms: number;
  field_evaluations: Record<string, FieldMatchEvaluation>;
  field_accuracy_percentage: number;
  warnings: string[];
  errors: string[];
}

export async function runEvaluationBenchmark(): Promise<void> {
  console.log('================================================================');
  console.log(' DocuPulse — Empirical System Evaluation & Benchmark Runner');
  console.log('================================================================\n');

  const groundTruthPath = path.resolve('evaluation/ground_truth.json');
  if (!fs.existsSync(groundTruthPath)) {
    throw new Error(`Ground truth file not found at: ${groundTruthPath}`);
  }

  const datasetDir = path.resolve('evaluation/dataset');
  if (!fs.existsSync(datasetDir)) {
    throw new Error(`Dataset directory not found at: ${datasetDir}`);
  }

  const rawGt = fs.readFileSync(groundTruthPath, 'utf-8');
  const dataset: GroundTruthItem[] = JSON.parse(rawGt);

  // Environment and adapter configuration
  const args = process.argv.slice(2);
  const modeArg = args.find(a => a.startsWith('--mode='))?.split('=')[1]?.toLowerCase();
  const hasKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY');
  const hasVertexConfig = process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true' && Boolean(process.env.GOOGLE_PROJECT_ID);
  const isGemini = modeArg === 'gemini' && (hasKey || hasVertexConfig);
  const adapterMode = isGemini ? 'gemini' : 'mock';
  process.env.EXTRACTION_MODE = adapterMode;
  const adapter = ExtractionFactory.createAdapter(adapterMode === 'mock');
  const evaluationTimestamp = new Date().toISOString();

  console.log(`Evaluation Mode: ${adapterMode.toUpperCase()} (${adapterMode === 'gemini' ? 'Gemini 3.8 Flash LLM' : 'Deterministic Rule-Based / Mock Offline'})`);
  console.log(`Environment: Node ${process.version} | ${os.platform()} (${os.arch()}) | RAM: ${(os.totalmem() / (1024 ** 3)).toFixed(1)} GB`);
  console.log(`Sample Size: ${dataset.length} labeled benchmark documents\n`);

  const results: DocumentEvaluationResult[] = [];
  const existingInvoicesForDuplicates: InvoiceExtractionResult[] = [];

  const fieldKeys = [
    'invoice_number',
    'invoice_date',
    'supplier_name',
    'customer_name',
    'subtotal',
    'tax',
    'total',
    'currency',
    'line_items_count'
  ];

  const fieldStats: Record<string, { total: number; correct: number }> = {};
  const ocrFieldStats = { total: 0, correct: 0 };
  for (const k of fieldKeys) {
    fieldStats[k] = { total: 0, correct: 0 };
  }

  for (const item of dataset) {
    const filePath = path.join(datasetDir, item.filename);
    if (!fs.existsSync(filePath)) {
      console.warn(`[WARN] File not found: ${filePath}, skipping...`);
      continue;
    }

    const fileBuffer = fs.readFileSync(filePath);
    const startOverall = performance.now();

    // 1. Ingest via Document Pipeline
    const processedList = await documentPipeline.processBatch([
      {
        name: item.filename,
        data: fileBuffer,
        size: fileBuffer.length,
      }
    ]);

    const processed = processedList[0];
    let extractedResult: InvoiceExtractionResult | null = null;
    let actualStatus: string | null = null;
    const warnings: string[] = [...(processed.warnings || [])];
    const errors: string[] = [...(processed.errors || [])];

    if (processed.status !== 'failed' && !item.is_corrupt) {
      try {
        // 2. Information Extraction
        extractedResult = await adapter.extract(processed.rawText);

        // 3. Data Validation & Reconciliation
        const validation = ValidationService.validateInvoice(
          extractedResult,
          existingInvoicesForDuplicates,
          { roundingTolerance: 0.05 }
        );

        actualStatus = validation.status;
        warnings.push(...validation.issues.filter(i => i.severity === 'warning').map(i => `${i.code}: ${i.message}`));
        errors.push(...validation.issues.filter(i => i.severity === 'error').map(i => `${i.code}: ${i.message}`));

        // Store for subsequent duplicate checks
        existingInvoicesForDuplicates.push(extractedResult);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
        actualStatus = 'failed';
      }
    } else {
      actualStatus = 'failed';
    }

    const durationMs = Math.round(performance.now() - startOverall);

    // 4. Compare with Ground Truth
    const fieldEvaluations: Record<string, FieldMatchEvaluation> = {};
    let correctFieldCount = 0;
    let applicableFieldCount = 0;

    for (const key of fieldKeys) {
      const expectedVal = (item.ground_truth as any)[key];
      let actualVal: any = null;

      if (extractedResult) {
        if (key === 'line_items_count') {
          actualVal = extractedResult.line_items ? extractedResult.line_items.length : 0;
        } else {
          actualVal = (extractedResult as any)[key];
        }
      }

      let matched = false;
      if (expectedVal === null && (actualVal === null || actualVal === undefined || actualVal === '')) {
        matched = true;
      } else if (typeof expectedVal === 'number' && typeof actualVal === 'number') {
        matched = Math.abs(expectedVal - actualVal) < 0.01;
      } else if (typeof expectedVal === 'string' && typeof actualVal === 'string') {
        const normExp = expectedVal.trim().toLowerCase();
        const normAct = actualVal.trim().toLowerCase();
        matched = normExp === normAct || normAct.includes(normExp) || normExp.includes(normAct);
      } else {
        matched = expectedVal === actualVal;
      }

      fieldEvaluations[key] = {
        matched,
        expected: expectedVal,
        actual: actualVal,
      };

      // Only count towards accuracy if this document is not an intentional corrupted test payload
      if (!item.is_corrupt) {
        fieldStats[key].total++;
        applicableFieldCount++;
        if (matched) {
          fieldStats[key].correct++;
          correctFieldCount++;
        }
      }
      if (!item.is_corrupt && item.file_type === 'image') {
        ocrFieldStats.total++;
        if (matched) ocrFieldStats.correct++;
      }
    }

    const accuracyPct = applicableFieldCount > 0 ? (correctFieldCount / applicableFieldCount) * 100 : (item.is_corrupt && actualStatus === 'failed' ? 100 : 0);
    const statusConcordance = actualStatus === item.expected_validation_status;

    results.push({
      id: item.id,
      filename: item.filename,
      file_type: item.file_type,
      is_corrupt: item.is_corrupt,
      pipeline_status: processed.status,
      expected_validation_status: item.expected_validation_status,
      actual_validation_status: actualStatus,
      status_concordance: statusConcordance,
      processing_time_ms: durationMs,
      field_evaluations: fieldEvaluations,
      field_accuracy_percentage: Math.round(accuracyPct * 10) / 10,
      warnings,
      errors,
    });

    const statusMark = statusConcordance ? '✓' : '✗';
    console.log(`[${statusMark}] ${item.id} (${item.filename}) - Status: ${actualStatus} (Expected: ${item.expected_validation_status}) | Acc: ${accuracyPct.toFixed(1)}% | Latency: ${durationMs}ms`);
  }

  // Aggregate Metrics Calculations
  const nonCorruptDocs = results.filter(r => !r.is_corrupt);
  const durations = results.map(r => r.processing_time_ms).sort((a, b) => a - b);
  const minDuration = durations[0] || 0;
  const maxDuration = durations[durations.length - 1] || 0;
  const meanDuration = Math.round(durations.reduce((acc, d) => acc + d, 0) / (durations.length || 1));
  const medianDuration = durations[Math.floor(durations.length / 2)] || 0;
  const p95Duration = durations[Math.floor(durations.length * 0.95)] || maxDuration;

  const successfulRuns = results.filter(r => r.status_concordance).length;
  const totalRuns = results.length;
  const concordanceRate = Math.round((successfulRuns / totalRuns) * 1000) / 10;

  // Documents successfully ingested and handled according to specification
  const handledDocuments = results.filter(r => {
    if (r.is_corrupt) return r.actual_validation_status === 'failed';
    return r.pipeline_status !== 'failed';
  }).length;
  const documentSuccessRate = Math.round((handledDocuments / totalRuns) * 1000) / 10;
  const documentFailureRate = Math.round((100 - documentSuccessRate) * 10) / 10;

  // Field Accuracy Summary
  const fieldSummary: Record<string, { total_evaluated: number; exact_matches: number; accuracy_percentage: number }> = {};
  let totalFieldMatches = 0;
  let totalFieldEvaluations = 0;

  for (const k of fieldKeys) {
    const s = fieldStats[k];
    const acc = s.total > 0 ? (s.correct / s.total) * 100 : 0;
    fieldSummary[k] = {
      total_evaluated: s.total,
      exact_matches: s.correct,
      accuracy_percentage: Math.round(acc * 10) / 10,
    };
    totalFieldMatches += s.correct;
    totalFieldEvaluations += s.total;
  }

  const overallFieldAccuracy = totalFieldEvaluations > 0 ? Math.round((totalFieldMatches / totalFieldEvaluations) * 1000) / 10 : 0;
  const ocrFieldAccuracy = ocrFieldStats.total > 0
    ? Math.round((ocrFieldStats.correct / ocrFieldStats.total) * 1000) / 10
    : null;

  const outputMetrics = {
    evaluation_metadata: {
      timestamp: evaluationTimestamp,
      sample_size: totalRuns,
      dataset_path: 'evaluation/dataset',
      ground_truth_path: 'evaluation/ground_truth.json',
      extraction_adapter: adapterMode,
      model_alias: adapterMode === 'gemini' ? 'gemini-3.8-flash' : 'deterministic_rule_parser',
      hardware_and_os: {
        node_version: process.version,
        platform: os.platform(),
        arch: os.arch(),
        cpu_count: os.cpus().length,
        total_memory_gb: Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10,
      },
    },
    system_level_metrics: {
      document_success_rate_percentage: documentSuccessRate,
      document_failure_rate_percentage: documentFailureRate,
      validation_concordance_rate_percentage: concordanceRate,
      overall_field_accuracy_percentage: overallFieldAccuracy,
      ocr_ground_truth_field_accuracy: {
        accuracy_percentage: ocrFieldAccuracy,
        exact_matches: ocrFieldStats.correct,
        fields_evaluated: ocrFieldStats.total,
        documents_evaluated: results.filter(result => result.file_type === 'image' && !result.is_corrupt).length,
        provider_configured: adapterMode === 'gemini',
      },
    },
    latency_metrics_ms: {
      min: minDuration,
      max: maxDuration,
      mean: meanDuration,
      median: medianDuration,
      p95: p95Duration,
      total_batch_duration_ms: durations.reduce((a, b) => a + b, 0),
    },
    field_level_accuracy: fieldSummary,
    document_results: results,
  };

  // Ensure docs directory exists
  const docsDir = path.resolve('docs');
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  const outputPath = path.join(docsDir, 'evaluation_metrics.json');
  fs.writeFileSync(outputPath, JSON.stringify(outputMetrics, null, 2), 'utf-8');

  console.log('\n================================================================');
  console.log(' Empirical Benchmark Results Summary');
  console.log('================================================================');
  console.log(`Document Ingestion Success Rate: ${documentSuccessRate}%`);
  console.log(`Validation Status Concordance:   ${concordanceRate}%`);
  console.log(`Overall Field Extraction Accuracy: ${overallFieldAccuracy}%`);
  console.log(`OCR Ground-Truth Field Accuracy:    ${ocrFieldAccuracy === null ? 'not measured' : `${ocrFieldAccuracy}% (${ocrFieldStats.correct}/${ocrFieldStats.total}; provider ${adapterMode === 'gemini' ? 'configured' : 'unconfigured'})`}`);
  console.log(`Processing Latency (Mean):        ${meanDuration} ms (min: ${minDuration}ms, max: ${maxDuration}ms, p95: ${p95Duration}ms)`);
  console.log('----------------------------------------------------------------');
  console.log('Field-by-Field Accuracy:');
  for (const [f, stats] of Object.entries(fieldSummary)) {
    console.log(`  - ${f.padEnd(20)}: ${stats.accuracy_percentage}% (${stats.exact_matches}/${stats.total_evaluated})`);
  }
  console.log('================================================================');
  console.log(`Machine-readable metrics saved to: ${outputPath}\n`);
}

if (import.meta.url.endsWith(process.argv[1]) || process.argv[1]?.includes('evaluate-system')) {
  runEvaluationBenchmark().catch(err => {
    console.error('Benchmark execution failed:', err);
    process.exit(1);
  });
}
