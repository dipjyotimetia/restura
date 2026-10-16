import { FlaskConical } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToggleField } from '@/components/ui/spatial';
import type {
  FrameAssertionConfig,
  FrameAssertionResult,
} from '@/features/websocket/store/useWebSocketStore';
import { cn } from '@/lib/shared/utils';

const EXAMPLE = `pm.test('frame is JSON with a type', () => {
  const frame = pm.response.json();
  pm.expect(frame).to.have.property('type');
});`;

const TONE: Record<FrameAssertionResult['status'], string> = {
  passed: 'var(--color-success)',
  failed: 'var(--color-danger)',
  error: 'var(--color-warning)',
};

/** Popover editor for the per-frame assertion script (#931). */
export function FrameAssertionButton({
  config,
  onChange,
}: {
  config: FrameAssertionConfig | undefined;
  onChange: (config: FrameAssertionConfig) => void;
}) {
  const enabled = config?.enabled ?? false;
  const [draft, setDraft] = useState(config?.script ?? '');
  useEffect(() => setDraft(config?.script ?? ''), [config?.script]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Frame assertions"
          title="Assertion script run on every received frame"
          className={cn(
            'inline-flex h-7 w-7 items-center justify-center rounded-sp-btn hover:bg-sp-hover hover:text-sp-text',
            enabled ? 'text-sp-accent' : 'text-sp-muted'
          )}
        >
          <FlaskConical className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 space-y-2 p-3">
        <div className="flex items-center gap-2">
          <span className="text-sp-13 font-medium text-sp-text">Frame assertions</span>
          <div className="flex-1" />
          <span className="text-sp-11 text-sp-muted">Enabled</span>
          <ToggleField
            size="sm"
            checked={enabled}
            onChange={(next) => onChange({ enabled: next, script: draft })}
            ariaLabel="Enable frame assertions"
          />
        </div>
        <p className="text-sp-11 text-sp-dim">
          Runs in the script sandbox for each received frame. Use{' '}
          <code className="font-mono">pm.response.text()</code> /{' '}
          <code className="font-mono">pm.response.json()</code> with{' '}
          <code className="font-mono">pm.test</code> and{' '}
          <code className="font-mono">pm.expect</code>. Results show in the transcript.
        </p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== (config?.script ?? '')) onChange({ enabled, script: draft });
          }}
          placeholder={EXAMPLE}
          aria-label="Frame assertion script"
          spellCheck={false}
          rows={8}
          className="block w-full resize-y rounded-sp-btn border border-sp-line bg-sp-surface-lo p-2 font-mono text-sp-12 text-sp-text outline-none placeholder:text-sp-dim"
        />
      </PopoverContent>
    </Popover>
  );
}

/** Compact pass/fail tag for a transcript row. */
export function FrameAssertionBadge({ result }: { result: FrameAssertionResult | undefined }) {
  if (!result) return null;
  const passed = result.tests.filter((t) => t.passed).length;
  const label =
    result.status === 'error'
      ? '! err'
      : `${result.status === 'passed' ? '✓' : '✗'} ${passed}/${result.tests.length}`;
  return (
    <span
      className="ml-2 inline-flex shrink-0 items-center rounded-sp-chip px-1 font-mono text-sp-11"
      style={{
        color: TONE[result.status],
        background: `color-mix(in srgb, ${TONE[result.status]} 14%, transparent)`,
      }}
      title={`Frame assertions ${result.status}`}
      data-testid="frame-assertion-badge"
    >
      {label}
    </span>
  );
}

/** Per-test breakdown for the selected-message panel. */
export function FrameAssertionDetails({ result }: { result: FrameAssertionResult | undefined }) {
  if (!result) return null;
  return (
    <ul className="mb-2 space-y-0.5 font-mono text-sp-11" aria-label="Frame assertion results">
      {result.tests.map((test, index) => (
        <li key={index} style={{ color: test.passed ? TONE.passed : TONE.failed }}>
          {test.passed ? '✓' : '✗'} {test.name}
          {test.error ? ` — ${test.error}` : ''}
        </li>
      ))}
      {result.status === 'error' &&
        result.errors.map((error, index) => (
          <li key={`e${index}`} style={{ color: TONE.error }}>
            ! {error}
          </li>
        ))}
    </ul>
  );
}
