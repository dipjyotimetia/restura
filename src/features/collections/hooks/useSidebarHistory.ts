import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useHistoryStore } from '@/store/useHistoryStore';
import type { RequestType } from '@/types';
import { historyItemMatches, historyItemMatchesFilter } from '../lib/sidebarSearch';

/**
 * History-tab data for the sidebar: the filtered list, the non-HTTP protocols
 * present (offered as filter chips), and the delete / clear actions.
 */
export function useSidebarHistory(
  searchQuery: string,
  methodFilter: string | null,
  visibleHistoryCount: number
) {
  const visibleHistory = useHistoryStore(
    useShallow((state) => state.history.slice(0, visibleHistoryCount))
  );
  // While searching or filtering, look through the whole history rather than
  // only the loaded page (otherwise older entries are unfindable).
  const allHistory = useHistoryStore((state) => state.history);
  const filteredHistory = useMemo(() => {
    let filtered = searchQuery || methodFilter ? allHistory : visibleHistory;
    if (searchQuery) filtered = filtered.filter((item) => historyItemMatches(item, searchQuery));
    if (methodFilter) {
      filtered = filtered.filter((item) => historyItemMatchesFilter(item, methodFilter));
    }
    return filtered;
  }, [allHistory, visibleHistory, searchQuery, methodFilter]);

  const historyProtocols = useHistoryStore(
    useShallow((state) => {
      const seen = new Set<RequestType>();
      for (const item of state.history) {
        if (item.request.type !== 'http') seen.add(item.request.type);
      }
      return [...seen].sort();
    })
  );
  const removeHistoryItem = useHistoryStore((state) => state.removeHistoryItem);
  const clearHistory = useHistoryStore((state) => state.clearHistory);

  return { filteredHistory, historyProtocols, removeHistoryItem, clearHistory };
}
