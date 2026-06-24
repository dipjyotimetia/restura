import { JSONPath } from 'jsonpath-plus';
import { X } from 'lucide-react';
import { useMemo, useState } from 'react';

interface JsonPathQueryProps {
  /** The (text) JSON response body. */
  body: string;
  onClose: () => void;
}

interface QueryOutcome {
  ok: boolean;
  count: number;
  output: string;
  error?: string;
}

/**
 * A live JSONPath query box over the JSON response body. Parses the body once,
 * evaluates the path on every keystroke (cheap for typical payloads), and shows
 * the matched subtree(s). Invalid JSON or an invalid path surface inline rather
 * than throwing. See https://github.com/JSONPath-Plus/JSONPath for syntax.
 */
export function JsonPathQuery({ body, onClose }: JsonPathQueryProps) {
  const [path, setPath] = useState('$');

  const parsed = useMemo<{ value: unknown; error?: string }>(() => {
    try {
      return { value: JSON.parse(body) };
    } catch {
      return { value: null, error: 'Response body is not valid JSON' };
    }
  }, [body]);

  const outcome = useMemo<QueryOutcome>(() => {
    if (parsed.error) return { ok: false, count: 0, output: '', error: parsed.error };
    if (!path.trim()) return { ok: true, count: 0, output: '' };
    try {
      const result = JSONPath({ path, json: parsed.value as object, wrap: true });
      const matches = Array.isArray(result) ? result : [result];
      return {
        ok: true,
        count: matches.length,
        output: JSON.stringify(matches.length === 1 ? matches[0] : matches, null, 2),
      };
    } catch (err) {
      return {
        ok: false,
        count: 0,
        output: '',
        error: err instanceof Error ? err.message : 'Invalid JSONPath expression',
      };
    }
  }, [path, parsed]);

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-sp-line bg-sp-surface">
        <span className="text-sp-10-5 text-sp-dim font-mono select-none">JSONPath</span>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          spellCheck={false}
          placeholder="$.data[*].id"
          aria-label="JSONPath expression"
          className="flex-1 h-7 px-2 rounded-sp-btn bg-sp-surface-lo border border-sp-line text-sp-12 font-mono outline-none focus:border-sp-line-strong"
        />
        <span className="text-sp-10-5 text-sp-dim font-mono tabular-nums min-w-12 text-right">
          {outcome.error ? '—' : `${outcome.count} match${outcome.count === 1 ? '' : 'es'}`}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close JSONPath query"
          className="size-6 inline-flex items-center justify-center rounded-sp-chip text-sp-dim hover:text-sp-text hover:bg-sp-hover transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {outcome.error ? (
          <div className="p-3">
            <p className="text-sp-12 text-amber-500 font-mono">{outcome.error}</p>
          </div>
        ) : (
          <pre className="p-3 text-sp-12 font-mono text-sp-text whitespace-pre-wrap break-words">
            {outcome.output}
          </pre>
        )}
      </div>
    </div>
  );
}

export default JsonPathQuery;
