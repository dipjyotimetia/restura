import { CheckCircle2, XCircle } from 'lucide-react';
import type { ScriptResult } from '@/types';

interface ResponseTestsPanelProps {
  /** Result of the post-response (test) script for the active tab, if it ran. */
  result: ScriptResult | undefined;
}

/** Pass/fail list for `pm.test(...)` assertions from the most recent send. */
export function ResponseTestsPanel({ result }: ResponseTestsPanelProps) {
  const tests = result?.tests ?? [];
  // The executor also logs each failed assertion as an error ("✗ name: msg");
  // those are already shown inline, so keep only genuine script errors.
  const failureLines = new Set(
    tests.filter((t) => !t.passed).map((t) => `✗ ${t.name}: ${t.error || 'Test failed'}`)
  );
  const errors = (result?.errors ?? []).filter((e) => !failureLines.has(e));

  if (tests.length === 0 && errors.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-1 text-center px-6">
        <p className="text-sp-12 text-sp-text">No tests ran for this response</p>
        <p className="text-sp-12 text-sp-dim">
          Add assertions in the request's Scripts tab, e.g.{' '}
          <code className="font-mono">pm.test('status is 200', …)</code>
        </p>
      </div>
    );
  }

  const passed = tests.filter((t) => t.passed).length;
  const failed = tests.length - passed;

  return (
    <div className="h-full overflow-auto p-3 space-y-3">
      {tests.length > 0 && (
        <p className="text-sp-12 text-sp-muted" aria-live="polite">
          {passed} passed{failed > 0 && `, ${failed} failed`} · {tests.length} total
        </p>
      )}
      {errors.length > 0 && (
        <div
          role="alert"
          className="rounded-sp-btn border border-[var(--color-danger)]/40 p-2 text-sp-12"
        >
          <p className="font-medium text-[var(--color-danger)]">Test script error</p>
          {errors.map((err, i) => (
            <p key={i} className="font-mono text-sp-muted whitespace-pre-wrap">
              {err}
            </p>
          ))}
        </div>
      )}
      <ul className="space-y-1">
        {tests.map((t, i) => (
          <li
            key={i}
            className="flex items-start gap-2 rounded-sp-btn px-2 py-1.5 hover:bg-[var(--sp-hover-bg)]"
          >
            {t.passed ? (
              <CheckCircle2
                className="h-4 w-4 shrink-0 mt-px text-[var(--color-success)]"
                aria-label="Passed"
              />
            ) : (
              <XCircle
                className="h-4 w-4 shrink-0 mt-px text-[var(--color-danger)]"
                aria-label="Failed"
              />
            )}
            <div className="min-w-0">
              <p className="text-sp-12 text-sp-text break-words">{t.name}</p>
              {!t.passed && t.error && (
                <p className="text-sp-12 font-mono text-sp-muted break-words">{t.error}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
