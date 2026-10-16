'use client';

import { type GraphQLHttpMethod, getRefusalReason } from '@/features/graphql/lib/graphqlHttp';
import { cn } from '@/lib/shared/utils';

interface GraphQLMethodToggleProps {
  method: GraphQLHttpMethod;
  isSubscription: boolean;
  /** The current document — used to flag a GET that would be refused. */
  query: string;
  /** The selected operation (operation picker), as Send will run it. */
  operationName?: string | null;
  onChange: (method: GraphQLHttpMethod) => void;
}

/**
 * URL-bar method chip for GraphQL. Click to switch between POST (JSON body)
 * and GET (query params, queries only — GraphQL-over-HTTP). Subscriptions run
 * over WebSocket, so they show a static SUB chip instead.
 */
export function GraphQLMethodToggle({
  method,
  isSubscription,
  query,
  operationName,
  onChange,
}: GraphQLMethodToggleProps) {
  const base =
    'flex items-center justify-center px-2 h-7 w-20 font-mono text-sp-11 font-bold tracking-wider rounded shrink-0 border';
  if (isSubscription) {
    return (
      <div
        className={cn(base, 'bg-violet-500/[0.12] border-violet-500/25 text-violet-400')}
        aria-label="GraphQL subscription"
      >
        SUB
      </div>
    );
  }
  // Same operation as Send runs: the picker's selection.
  const refusal = method === 'GET' ? getRefusalReason(query, operationName) : null;
  const next: GraphQLHttpMethod = method === 'GET' ? 'POST' : 'GET';
  return (
    <button
      type="button"
      onClick={() => onChange(next)}
      aria-label={`GraphQL HTTP method: ${method}. Switch to ${next}`}
      title={
        refusal ??
        (method === 'GET'
          ? 'GET — query, variables and operationName go in the URL (queries only). Click for POST.'
          : 'POST — JSON body. Click for GET (queries only, cache-friendly).')
      }
      className={cn(
        base,
        'transition-colors',
        refusal
          ? 'bg-destructive/10 border-destructive/40 text-destructive'
          : method === 'GET'
            ? 'bg-emerald-500/[0.12] border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/20'
            : 'bg-amber-500/[0.12] border-amber-500/25 text-amber-400 hover:bg-amber-500/20'
      )}
    >
      {method}
    </button>
  );
}
