import { X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { JsonTreeFocus } from '@/components/shared/JsonTree';
import { Skeleton } from '@/components/ui/skeleton';
import {
  errorTreeHighlights,
  errorTreePath,
  parseGraphQLErrors,
  resolveExistingPath,
  subscriptionErrors,
} from '@/features/graphql/lib/graphqlErrors';
import type { SubscriptionLogMessage } from '@/features/graphql/lib/subscriptionLog';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { GraphQLErrorsPanel, type GraphQLErrorsPanelItem } from './GraphQLErrorsPanel';

const JsonTree = lazyComponent(
  () => import('@/components/shared/JsonTree'),
  <div className="p-3">
    <Skeleton className="h-4 w-1/2 rounded" />
  </div>
);

interface GraphQLSubscriptionErrorsProps {
  messages: readonly SubscriptionLogMessage[];
  tabId: string | undefined;
}

interface Inspected {
  messageId: string;
  payload: unknown;
  focus: JsonTreeFocus;
}

/**
 * Errors carried by subscription `next` payloads. Clicking a path opens that
 * event's payload as a tree with the erroring node highlighted.
 */
export function GraphQLSubscriptionErrors({ messages, tabId }: GraphQLSubscriptionErrorsProps) {
  const entries = useMemo(() => subscriptionErrors(messages), [messages]);
  const [inspected, setInspected] = useState<Inspected | null>(null);
  const highlights = useMemo(
    () =>
      inspected
        ? errorTreeHighlights(inspected.payload, parseGraphQLErrors(inspected.payload))
        : [],
    [inspected]
  );

  if (entries.length === 0) return null;

  const items: GraphQLErrorsPanelItem[] = entries.map((entry) => ({
    key: `${entry.messageId}:${entry.error.index}`,
    error: entry.error,
  }));

  const inspect = (item: GraphQLErrorsPanelItem, path: (string | number)[]) => {
    const entry = entries.find((e) => `${e.messageId}:${e.error.index}` === item.key);
    if (!entry) return;
    setInspected((prev) => ({
      messageId: entry.messageId,
      payload: entry.payload,
      focus: {
        path: resolveExistingPath(entry.payload, errorTreePath(path)),
        nonce: (prev?.focus.nonce ?? 0) + 1,
      },
    }));
  };

  return (
    <section
      aria-label="Subscription errors"
      className="mb-3 rounded-sp-btn border border-destructive/20 bg-destructive/5"
    >
      <div className="flex items-center px-3 pt-2 sp-label">
        {entries.length} error{entries.length === 1 ? '' : 's'} in events
      </div>
      <div className="max-h-56 overflow-auto">
        <GraphQLErrorsPanel items={items} tabId={tabId} onSelectPath={inspect} />
      </div>
      {inspected && (
        <div className="border-t border-destructive/20">
          <div className="flex items-center justify-between px-3 pt-1.5">
            <span className="sp-label">Event payload</span>
            <button
              type="button"
              onClick={() => setInspected(null)}
              aria-label="Close payload"
              className="inline-flex size-5 items-center justify-center rounded-sp-chip text-sp-dim hover:text-sp-text hover:bg-sp-hover"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <div className="max-h-64 overflow-auto">
            <JsonTree
              key={inspected.messageId}
              value={inspected.payload}
              highlights={highlights}
              focus={inspected.focus}
            />
          </div>
        </div>
      )}
    </section>
  );
}
