// Ensure hermetic offline execution during test runs without paid API dependencies
process.env.EXTRACTION_MODE = 'mock';
process.env.OCR_PROVIDER = 'mock';

import { runDocumentProcessingTests } from '../src/services/document/tests.ts';
import { runInformationExtractionTests } from '../src/services/extraction/tests.ts';
import { runDataValidationTests } from '../src/services/validation/tests.ts';
import { runBackendApiTests } from '../src/services/api/tests.ts';
import { runDatabaseAndSearchTests } from '../src/services/database/tests.ts';
import { runSecurityTests } from '../src/services/api/security.tests.ts';
import { runPdfProcessorTests } from '../src/services/document/pdfProcessor.tests.ts';
import { runReconciliationTests } from '../src/services/validation/reconciliation.tests.ts';
import { runGroundingTests } from '../src/services/extraction/grounding.tests.ts';
import { runAdapterTests } from '../src/services/extraction/adapter.tests.ts';

async function main() {
  console.log('================================================================');
  console.log(' DocuPulse - AI Document Intelligence System: Full Test Suite');
  console.log('================================================================\n');

  console.log('--- MODULE 1: MULTI-FORMAT DOCUMENT PROCESSING ---');
  const task1Suite = await runDocumentProcessingTests();
  for (const r of task1Suite.results) {
    const symbol = r.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`[${symbol}] ${r.name} (${r.durationMs}ms)`);
    if (!r.passed) {
      console.log(`    Error: ${r.details}`);
    }
  }

  console.log('\n--- MODULE 2: AI INFORMATION EXTRACTION ---');
  const task2Suite = await runInformationExtractionTests();
  for (const r of task2Suite.results) {
    const symbol = r.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`[${symbol}] ${r.name} (${r.durationMs}ms)`);
    if (!r.passed) {
      console.log(`    Error: ${r.details}`);
    }
  }

  console.log('\n--- MODULE 3: DATA VALIDATION & RECONCILIATION ---');
  const task3Suite = await runDataValidationTests();
  for (const r of task3Suite.results) {
    const symbol = r.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`[${symbol}] ${r.name} (${r.durationMs}ms)`);
    if (!r.passed) {
      console.log(`    Error: ${r.details}`);
    }
  }

  console.log('\n--- MODULE 4: BACKEND REST API & JOB QUEUE ---');
  const task4Suite = await runBackendApiTests();
  for (const r of task4Suite.results) {
    const symbol = r.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`[${symbol}] ${r.name} (${r.durationMs}ms)`);
    if (!r.passed) {
      console.log(`    Error: ${r.details}`);
    }
  }

  console.log('\n--- MODULE 5: DATABASE & SEARCH ---');
  const task5Suite = await runDatabaseAndSearchTests();
  for (const r of task5Suite.results) {
    const symbol = r.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`[${symbol}] ${r.name} (${r.durationMs}ms)`);
    if (!r.passed) {
      console.log(`    Error: ${r.details}`);
    }
  }

  console.log('\n--- MODULE 6: HARDENING (SECURITY, PDF SAFETY, RECONCILIATION, GROUNDING, ADAPTER) ---');
  const hardeningSuites = [
    await runSecurityTests(),
    await runPdfProcessorTests(),
    await runReconciliationTests(),
    await runGroundingTests(),
    await runAdapterTests(),
  ];
  for (const suite of hardeningSuites) {
    for (const r of suite.results) {
      const symbol = r.passed ? '✓ PASS' : '✗ FAIL';
      console.log(`[${symbol}] ${r.name} (${r.durationMs}ms)`);
      if (!r.passed) console.log(`    Error: ${r.details}`);
    }
  }
  const hardening = {
    total: hardeningSuites.reduce((sum, suite) => sum + suite.total, 0),
    passed: hardeningSuites.reduce((sum, suite) => sum + suite.passed, 0),
    failed: hardeningSuites.reduce((sum, suite) => sum + suite.failed, 0),
  };

  const total = task1Suite.total + task2Suite.total + task3Suite.total + task4Suite.total + task5Suite.total + hardening.total;
  const passed = task1Suite.passed + task2Suite.passed + task3Suite.passed + task4Suite.passed + task5Suite.passed + hardening.passed;
  const failed = task1Suite.failed + task2Suite.failed + task3Suite.failed + task4Suite.failed + task5Suite.failed + hardening.failed;

  console.log('\n================================================================');
  console.log(`Overall Summary: ${passed} passed, ${failed} failed of ${total} total tests.`);
  console.log('================================================================');

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('Test execution failed:', err);
  process.exitCode = 1;
});
