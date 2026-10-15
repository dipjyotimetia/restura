import { AlertCircle, Braces, CornerDownRight } from 'lucide-react';
import {
  formatErrorPath,
  type GraphQLErrorEntry,
  type GraphQLErrorPathSegment,
} from '@/features/graphql/lib/graphqlErrors';
import { useGraphQLErrorStore } from '@/features/graphql/store/useGraphQLErrorStore';
import { cn } from '@/lib/shared/utils';
import { useRequestStore } from '@/store/useRequestStore';

export interface GraphQLErrorsPanelItem {
  /** Stable React key. */
  key: string;
  error: GraphQLErrorEntry;
}

interface GraphQLErrorsPanelProps {
  items: readonly GraphQLErrorsPanelItem[];
  /** Tab whose query editor "jump to location" targets. */
  tabId: string | undefined;
  /** Reveal the error's `path` in the response tree. */
  onSelectPath?: (item: GraphQLErrorsPanelItem, path: GraphQLErrorPathSegment[]) => void;
  className?: string;
}

const chip =
  'inline-flex items-center gap-1 h-5 px-1.5 rounded-sp-chip text-sp-11 font-mono transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent';

/**
 * Every entry of a GraphQL `errors[]`: message, `extensions.code`, `path`
 * (click → response tree) and `locations` (click → query editor).
 */
export function GraphQLErrorsPanel({
  items,
  tabId,
  onSelectPath,
  className,
}: GraphQLErrorsPanelProps) {
  const focusLocation = useGraphQLErrorStore((s) => s.focusLocation);
  // Locations are only meaningful against the query as it was sent; once the
  // editor text changes (or there's no record of the send), don't offer a jump.
  const sentQuery = useGraphQLErrorStore((s) => (tabId ? s.byTab[tabId]?.query : undefined));
  const editorQuery = useRequestStore((s) => {
    const request = tabId ? s.tabs.find((t) => t.id === tabId)?.request : undefined;
    return request?.type === 'http' ? request.body.raw : undefined;
  });
  const canLocate = Boolean(tabId) && sentQuery !== undefined && sentQuery === editorQuery;

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sp-12 text-sp-dim font-mono">No GraphQL errors</p>
      </div>
    );
  }

  return (
    <ul aria-label="GraphQL errors" className={cn('divide-y divide-sp-line', className)}>
      {items.map((item) => {
        const { error } = item;
        const { path } = error;
        return (
          <li key={item.key} className="px-3 py-2 space-y-1.5">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
              <span className="min-w-0 flex-1 break-words text-sp-12 text-sp-text">
                {error.message}
              </span>
              {error.code && (
                <span className="shrink-0 rounded-sp-chip border border-sp-line px-1.5 font-mono text-sp-11 text-sp-muted">
                  {error.code}
                </span>
              )}
            </div>
            {(path || error.locations.length > 0) && (
              <div className="flex flex-wrap items-center gap-1.5 pl-5">
                {path &&
                  (onSelectPath ? (
                    <button
                      type="button"
                      onClick={() => onSelectPath(item, path)}
                      title="Show in response tree"
                      aria-label={`Show ${formatErrorPath(path)} in response`}
                      className={cn(chip, 'text-sp-accent hover:bg-sp-hover')}
                    >
                      <Braces className="h-3 w-3" aria-hidden />
                      {formatErrorPath(path)}
                    </button>
                  ) : (
                    <span className={cn(chip, 'text-sp-muted')}>
                      <Braces className="h-3 w-3" aria-hidden />
                      {formatErrorPath(path)}
                    </span>
                  ))}
                {error.locations.map((loc) => (
                  <button
                    key={`${loc.line}:${loc.column}`}
                    type="button"
                    disabled={!canLocate}
                    onClick={() => tabId && focusLocation(tabId, loc)}
                    title={
                      canLocate
                        ? 'Go to location in query'
                        : 'The query changed since this response; send it again to locate errors'
                    }
                    aria-label={`Go to query line ${loc.line}, column ${loc.column}`}
                    className={cn(
                      chip,
                      'text-sp-muted hover:text-sp-text hover:bg-sp-hover disabled:opacity-50'
                    )}
                  >
                    <CornerDownRight className="h-3 w-3" aria-hidden />
                    {`Ln ${loc.line}, Col ${loc.column}`}
                  </button>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
