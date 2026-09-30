import { useMemo } from 'react';
import type { RequestErrorInfo } from '@/features/http/lib/classifyRequestError';
import { useVariableStatus } from '@/hooks/useVariableStatus';
import { formatBytes } from '@/lib/shared/utils';
import { findVariableTokens } from '@/lib/shared/variableTokens';

/**
 * Body-pane card for a transport-level failure: what happened, what to try, and
 * (when relevant) which `{{vars}}` have no value — the usual cause of a URL that
 * fails to resolve. The raw message is always shown.
 */
export function RequestErrorCard({ info, url }: { info: RequestErrorInfo; url: string }) {
  const getVarStatus = useVariableStatus();
  const unresolved = useMemo(
    () => [
      ...new Set(
        findVariableTokens(url)
          .filter((t) => getVarStatus(t.name) === 'unresolved')
          .map((t) => t.name)
      ),
    ],
    [url, getVarStatus]
  );
  return (
    <div role="alert" className="h-full overflow-auto p-4 space-y-3">
      <p className="text-sp-13 font-medium text-sp-text">{info.title}</p>
      {info.hint && <p className="text-sp-12 text-sp-dim">{info.hint}</p>}
      {unresolved.length > 0 && (
        <p className="text-sp-12 text-sp-dim">
          This request references variables with no value in the active scope:{' '}
          <span className="font-mono text-sp-text">
            {unresolved.map((v) => `{{${v}}}`).join(', ')}
          </span>
          . Check the selected environment.
        </p>
      )}
      <pre className="whitespace-pre-wrap break-words rounded-sp-btn border border-sp-line bg-sp-surface-lo p-2 font-mono text-sp-11 text-sp-dim">
        {info.raw}
      </pre>
    </div>
  );
}

/** Shown above an oversized JSON body that was left unformatted. */
export function LargeBodyNotice({ size, onFormat }: { size: number; onFormat: () => void }) {
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-sp-line px-3 py-1.5 text-sp-11 text-sp-dim"
    >
      <span className="flex-1">
        Large body ({formatBytes(size)}) — shown unformatted to keep the app responsive.
      </span>
      <button
        type="button"
        onClick={onFormat}
        className="rounded-sp-btn border border-sp-line px-2 py-0.5 font-mono text-sp-text hover:bg-sp-hover transition-colors"
      >
        Format anyway
      </button>
    </div>
  );
}
