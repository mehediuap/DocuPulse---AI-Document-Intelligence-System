// Ensure hermetic offline execution during test runs without paid API dependencies
process.env.EXTRACTION_MODE = 'mock';

import { runDocumentProcessingTests } from '../src/services/document/tests.ts';
import { runInformationExtractionTests } from '../src/services/extraction/tests.ts';
import { runDataValidationTests } from '../src/services/validation/tests.ts';
import { runBackendApiTests } from '../src/services/api/tests.ts';
import { runDatabaseAndSearchTests } from '../src/services/database/tests.ts';

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

  const total = task1Suite.total + task2Suite.total + task3Suite.total + task4Suite.total + task5Suite.total;
  const passed = task1Suite.passed + task2Suite.passed + task3Suite.passed + task4Suite.passed + task5Suite.passed;
  const failed = task1Suite.failed + task2Suite.failed + task3Suite.failed + task4Suite.failed + task5Suite.failed;

  console.log('\n================================================================');
  console.log(`Overall Summary: ${passed} passed, ${failed} failed of ${total} total tests.`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
