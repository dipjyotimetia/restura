import { CodeEditorFrame, Floater, Stat } from '@/components/ui/spatial';
import { useMcpStore, type McpInvocationLog } from '@/features/mcp/store/useMcpStore';

function McpResult({ entry }: { entry: McpInvocationLog }) {
  const isError = entry.error !== undefined;
  const payload: unknown = isError
    ? {
        error: entry.error,
        ...(entry.jsonRpcError ? { jsonRpcError: entry.jsonRpcError } : {}),
      }
    : entry.result;
  const json = JSON.stringify(payload, null, 2);
  const lines = json.split('\n').length;
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
              color: isError ? 'var(--color-danger)' : 'var(--color-success)',
              background: isError
                ? 'color-mix(in srgb, var(--color-danger) 14%, transparent)'
                : 'color-mix(in srgb, var(--color-success) 14%, transparent)',
            }}
          >
            isError: {isError ? 'true' : 'false'}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <Stat label="Time" value={`${entry.durationMs.toFixed(0)}ms`} align="right" />
          <Stat label="Size" value={sizeLabel} align="right" />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3">
        <CodeEditorFrame lineCount={lines} className="h-full">
          <pre className="text-sp-12 font-mono text-sp-text whitespace-pre-wrap break-all">
            {json}
          </pre>
        </CodeEditorFrame>
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
        <McpResult entry={entry} />
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
