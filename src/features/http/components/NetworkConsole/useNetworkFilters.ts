import { useMemo, useState } from 'react';
import { filterEntries, sortEntries, statusClassCounts } from '@/lib/shared/console-filter';
import type { ConsoleEntry, ConsoleProtocol, ConsoleStatusFilter } from '@/store/useConsoleStore';

export type NetworkSort = 'recent' | 'time' | 'size' | 'status';

export const STATUS_FILTERS: Array<{ value: ConsoleStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: '2xx', label: '2xx' },
  { value: '3xx', label: '3xx' },
  { value: '4xx', label: '4xx' },
  { value: '5xx', label: '5xx' },
  { value: 'errored', label: 'Errored' },
];

// Only protocols that can appear in the network entry list today. Frame-only
// protocols belong in the Frames tab.
export const PROTOCOL_FILTERS: Array<{ value: ConsoleProtocol | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'http', label: 'HTTP' },
  { value: 'grpc', label: 'gRPC' },
  { value: 'graphql', label: 'GraphQL' },
  { value: 'mcp', label: 'MCP' },
  { value: 'sse', label: 'SSE' },
];

export const SORT_OPTIONS: Array<{ value: NetworkSort; label: string }> = [
  { value: 'recent', label: 'Recent' },
  { value: 'time', label: 'Time' },
  { value: 'size', label: 'Size' },
  { value: 'status', label: 'Status' },
];

interface NetworkFilterInput {
  entries: ConsoleEntry[];
  searchFilter: string;
  statusFilter: ConsoleStatusFilter;
  protocolFilter: ConsoleProtocol | 'all';
  runFilter: string;
}

/**
 * Keeps all derived list state in one renderer-only boundary. The store still
 * owns persisted filters; sort remains deliberately local to the current view.
 */
export function useNetworkFilters({
  entries,
  searchFilter,
  statusFilter,
  protocolFilter,
  runFilter,
}: NetworkFilterInput) {
  const [sortBy, setSortBy] = useState<NetworkSort>('recent');

  const runs = useMemo(() => {
    const seen = new Map<string, string>();
    for (const entry of entries) {
      if (entry.runId && !seen.has(entry.runId)) seen.set(entry.runId, entry.runLabel ?? 'Run');
    }
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [entries]);

  const protocolsPresent = useMemo(() => {
    const protocols = new Set<string>();
    for (const entry of entries) protocols.add(entry.protocol ?? 'http');
    return protocols;
  }, [entries]);

  const filteredEntries = useMemo(
    () =>
      sortEntries(
        filterEntries(entries, { query: searchFilter, statusFilter, protocolFilter, runFilter }),
        sortBy
      ),
    [entries, searchFilter, statusFilter, protocolFilter, runFilter, sortBy]
  );

  const classCounts = useMemo(() => statusClassCounts(entries), [entries]);
  const maxTime = useMemo(
    () =>
      filteredEntries.length > 1
        ? filteredEntries.reduce((maximum, entry) => Math.max(maximum, entry.response.time), 0)
        : 0,
    [filteredEntries]
  );
  const filtersActive =
    statusFilter !== 'all' ||
    protocolFilter !== 'all' ||
    runFilter !== 'all' ||
    searchFilter.trim().length > 0;

  return {
    classCounts,
    filteredEntries,
    filtersActive,
    maxTime,
    protocolsPresent,
    runs,
    setSortBy,
    sortBy,
  };
}
