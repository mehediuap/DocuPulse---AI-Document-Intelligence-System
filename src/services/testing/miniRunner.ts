/** Tiny shared test runner matching the shape used by the existing suites. */
export interface TestRunResult { name: string; passed: boolean; durationMs: number; details: string }
export interface SuiteResult { total: number; passed: number; failed: number; results: TestRunResult[] }

export function createSuite() {
  const results: TestRunResult[] = [];
  return {
    async test(name: string, fn: () => void | Promise<void>) {
      const start = performance.now();
      try {
        await fn();
        results.push({ name, passed: true, durationMs: Math.round(performance.now() - start), details: 'Passed with verified assertions' });
      } catch (e) {
        results.push({ name, passed: false, durationMs: Math.round(performance.now() - start), details: e instanceof Error ? e.message : String(e) });
      }
    },
    finish(): SuiteResult {
      const passed = results.filter(r => r.passed).length;
      return { total: results.length, passed, failed: results.length - passed, results };
    },
  };
}
