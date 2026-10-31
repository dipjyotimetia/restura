import { useState } from 'react';
import { MCP_LOG_LEVELS, type McpLogLevel } from '@/features/mcp/lib/mcpClient';

/**
 * `logging/setLevel` picker. Render only when the server advertises the
 * `logging` capability. Reverts to the previous level if the server rejects.
 */
export function McpLogLevelPicker({
  onSetLevel,
}: {
  onSetLevel: (level: McpLogLevel) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [level, setLevel] = useState<McpLogLevel | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleChange = async (next: McpLogLevel) => {
    const previous = level;
    setLevel(next);
    setError(null);
    setBusy(true);
    try {
      const res = await onSetLevel(next);
      if (!res.ok) {
        setLevel(previous);
        setError(res.error ?? 'logging/setLevel failed');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <label className="inline-flex items-center gap-1.5 text-sp-11 text-sp-muted">
      <span className="sp-label">Log level</span>
      <select
        aria-label="Log level"
        value={level}
        disabled={busy}
        onChange={(event) => void handleChange(event.target.value as McpLogLevel)}
        className="h-6 rounded-sp-btn border border-sp-line bg-sp-surface-lo px-1.5 font-mono text-sp-11 text-sp-text"
      >
        <option value="" disabled>
          Server default
        </option>
        {MCP_LOG_LEVELS.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
      {error && (
        <span role="alert" className="text-rose-400">
          {error}
        </span>
      )}
    </label>
  );
}
