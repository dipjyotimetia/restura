import { useCallback, useEffect, useState } from 'react';
import {
  clearReleaseNotesCache,
  fetchReleaseNotesPage,
  type ReleaseNote,
  type ReleaseNotesChannel,
} from '@/lib/shared/release-notes';

export function useReleaseNotes(channel: ReleaseNotesChannel) {
  const [releases, setReleases] = useState<ReleaseNote[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    async (refresh = false) => {
      if (refresh) clearReleaseNotesCache();
      setLoading(true);
      setError(null);
      try {
        const page = await fetchReleaseNotesPage({ channel });
        setReleases(page.releases);
        setSelectedId(page.releases[0]?.id ?? null);
        setNextPage(page.nextPage);
      } catch (cause) {
        setReleases([]);
        setSelectedId(null);
        setNextPage(null);
        setError(
          cause instanceof Error ? cause.message : 'Release notes are unavailable right now.'
        );
      } finally {
        setLoading(false);
      }
    },
    [channel]
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadMore = useCallback(async () => {
    if (nextPage == null) return;
    setLoadingMore(true);
    try {
      const page = await fetchReleaseNotesPage({ channel, page: nextPage });
      setReleases((current) => [...current, ...page.releases]);
      setNextPage(page.nextPage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Release notes are unavailable right now.');
    } finally {
      setLoadingMore(false);
    }
  }, [channel, nextPage]);

  return {
    releases,
    selectedId,
    setSelectedId,
    nextPage,
    loading,
    loadingMore,
    error,
    reload,
    loadMore,
  };
}
