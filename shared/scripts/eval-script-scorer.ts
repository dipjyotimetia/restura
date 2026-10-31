// Lives under shared/scripts (not shared/ai-lab) so Electron main, which never
// bundles the QuickJS library bundle, does not compile it.
import type { ScriptScoreResult } from '../ai-lab/scorers';
import ScriptExecutor from './script-executor';

/** Run a `script` scorer in the QuickJS sandbox against a synthetic text response. */
export async function runScriptScorer(args: {
  code: string;
  output: string;
  latencyMs: number;
}): Promise<ScriptScoreResult> {
  const executor = new ScriptExecutor();
  const result = await executor.executeScript(args.code, {
    response: {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/plain' },
      body: args.output,
      time: args.latencyMs,
      size: args.output.length,
    },
  });
  const tests = result.tests ?? [];
  const failures = tests
    .filter((t) => !t.passed)
    .map((t) => (t.error ? `${t.name}: ${t.error}` : t.name));
  failures.push(...result.errors);
  const passed = result.errors.length === 0 && tests.every((t) => t.passed) && tests.length > 0;
  return { passed, failures };
}
