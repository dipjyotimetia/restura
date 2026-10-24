import { validateToolOutput } from '@shared/protocol/mcp-output-schema';
import { classifyMcpOutcome, type McpOutcomeKind } from '@shared/protocol/mcp-result';
import { useState } from 'react';
import { JsonBodyView } from '@/components/shared/JsonBodyView';
import { Floater, Stat } from '@/components/ui/spatial';
import { type McpInvocationLog, useMcpStore } from '@/features/mcp/store/useMcpStore';

const BADGE_LABEL: Record<McpOutcomeKind, string> = {
  ok: 'isError: false',
  'tool-error': 'TOOL ERROR · isError: true',
  'protocol-error': 'PROTOCOL ERROR',
};

function structuredContentOf(result: unknown): unknown {
  return typeof result === 'object' && result !== null
    ? (result as { structuredContent?: unknown }).structuredContent
    : undefined;
}

function McpResult({ entry }: { entry: McpInvocationLog }) {
  const isCancelled = entry.cancelled === true;
  const kind = classifyMcpOutcome(entry);
  const isError = kind !== 'ok' && !isCancelled;
  const structured = structuredContentOf(entry.result);
  const [view, setView] = useState<'result' | 'structured'>('result');
  const validation =
    entry.outputSchema && kind === 'ok'
      ? validateToolOutput(entry.outputSchema, entry.result)
      : ({ status: 'no-schema' } as const);
  const showStructured = view === 'structured' && structured !== undefined;
  const payload: unknown = isCancelled
    ? { cancelled: true, reason: entry.error }
    : showStructured
      ? structured
      : entry.error !== undefined
        ? {
            error: entry.error,
            ...(entry.jsonRpcError ? { jsonRpcError: entry.jsonRpcError } : {}),
          }
        : entry.result;
  const json = JSON.stringify(payload, null, 2);
  const bytes = new TextEncoder().encode(json).length;
  const sizeLabel = bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between gap-3 px-3 h-10 border-b border-sp-line shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="sp-label">Result</span>
          <span
            className="inline-flex items-center gap-1 px-1.5 h-5 rounded-[5px] font-mono font-bold text-sp-9 tracking-wider"
            style={{
              color: isCancelled
                ? 'var(--color-warning)'
                : isError
                  ? 'var(--color-danger)'
                  : 'var(--color-success)',
              background: `color-mix(in srgb, ${
                isCancelled
                  ? 'var(--color-warning)'
                  : isError
                    ? 'var(--color-danger)'
                    : 'var(--color-success)'
              } 14%, transparent)`,
            }}
          >
            {isCancelled ? 'cancelled' : BADGE_LABEL[kind]}
          </span>
          {structured !== undefined && (
            <button
              type="button"
              onClick={() => setView(view === 'result' ? 'structured' : 'result')}
              className="px-1.5 h-5 rounded-[5px] font-mono text-sp-11 text-sp-muted hover:text-sp-text hover:bg-sp-hover"
            >
              {view === 'result' ? 'Show structuredContent' : 'Show full result'}
            </button>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <Stat label="Time" value={`${entry.durationMs.toFixed(0)}ms`} align="right" />
          <Stat label="Size" value={sizeLabel} align="right" />
        </div>
      </div>
      {(validation.status === 'invalid' || validation.status === 'missing') && (
        <div
          role="alert"
          data-testid="mcp-output-schema-issues"
          className="px-3 py-1.5 border-b border-sp-line text-sp-11-5 shrink-0"
          style={{ color: 'var(--color-warning)' }}
        >
          <div className="font-bold">
            structuredContent does not match the tool&apos;s outputSchema
          </div>
          <ul className="font-mono text-sp-11 list-disc pl-4">
            {validation.issues.slice(0, 5).map((issue) => (
              <li key={`${issue.path}:${issue.message}`}>
                {issue.path}: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {validation.status === 'skipped' && (
        <div
          data-testid="mcp-output-schema-skipped"
          className="px-3 py-1 border-b border-sp-line text-sp-11 font-mono shrink-0 text-sp-muted"
        >
          outputSchema too complex to validate — skipped
        </div>
      )}
      {validation.status === 'valid' && (
        <div
          data-testid="mcp-output-schema-ok"
          className="px-3 py-1 border-b border-sp-line text-sp-11 font-mono shrink-0"
          style={{ color: 'var(--color-success)' }}
        >
          structuredContent matches outputSchema
        </div>
      )}
      <div className="flex-1 min-h-0">
        <JsonBodyView
          text={json}
          downloadName={`mcp-${entry.method.replace(/\//g, '-')}-result`}
          editorPath={`mcp-result-${entry.id}`}
        />
      </div>
    </div>
  );
}

/**
 * Result panel for the MCP workspace — the resizable sibling of
 * McpRequestBuilder (route-level ResizableLayout), mirroring how ResponseViewer
 * pairs with the HTTP builder. Self-sufficient: reads the latest invocation
 * from the active MCP connection's log.
 */
export default function McpResultPanel() {
  const active = useMcpStore((s) => s.getActive());
  const entry = active && active.log.length > 0 ? (active.log[0] ?? null) : null;

  return (
    <Floater
      radius="panel"
      elevation="float-lg"
      className="border border-sp-line flex flex-col overflow-hidden h-full min-h-0"
      style={{ background: 'var(--sp-code)' }}
    >
      {entry ? (
        <McpResult key={entry.id} entry={entry} />
      ) : (
        <div className="flex-1 grid place-items-center text-center px-4">
          <div>
            <div className="font-mono text-sp-12 text-sp-muted">No result yet</div>
            <div className="mt-1 text-sp-11-5 text-sp-dim">Invoke a tool to see output here.</div>
          </div>
        </div>
      )}
    </Floater>
  );
}
