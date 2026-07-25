import { useCallback, useEffect, useRef, useState } from 'react';
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
  const requestVersionRef = useRef(0);
  const nextPageRef = useRef<number | null>(null);
  const loadMoreInFlightRef = useRef<Promise<void> | null>(null);

  const reload = useCallback(
    async (refresh = false) => {
      const requestVersion = ++requestVersionRef.current;
      nextPageRef.current = null;
      loadMoreInFlightRef.current = null;
      if (refresh) clearReleaseNotesCache();
      setLoading(true);
      setLoadingMore(false);
      setError(null);
      try {
        const page = await fetchReleaseNotesPage({ channel });
        if (requestVersion !== requestVersionRef.current) return;

        setReleases(page.releases);
        setSelectedId(page.releases[0]?.id ?? null);
        setNextPage(page.nextPage);
        nextPageRef.current = page.nextPage;
      } catch (cause) {
        if (requestVersion !== requestVersionRef.current) return;

        setReleases([]);
        setSelectedId(null);
        setNextPage(null);
        nextPageRef.current = null;
        setError(
          cause instanceof Error ? cause.message : 'Release notes are unavailable right now.'
        );
      } finally {
        if (requestVersion === requestVersionRef.current) setLoading(false);
      }
    },
    [channel]
  );

  useEffect(() => {
    void reload();
    return () => {
      requestVersionRef.current += 1;
      nextPageRef.current = null;
      loadMoreInFlightRef.current = null;
    };
  }, [reload]);

  const loadMore = useCallback((): Promise<void> => {
    const inFlight = loadMoreInFlightRef.current;
    if (inFlight) return inFlight;

    const pageNumber = nextPageRef.current;
    if (pageNumber == null) return Promise.resolve();

    const requestVersion = requestVersionRef.current;
    setLoadingMore(true);
    let request!: Promise<void>;
    request = (async () => {
      try {
        const page = await fetchReleaseNotesPage({ channel, page: pageNumber });
        if (requestVersion !== requestVersionRef.current) return;

        setReleases((current) => [...current, ...page.releases]);
        setNextPage(page.nextPage);
        nextPageRef.current = page.nextPage;
      } catch (cause) {
        if (requestVersion !== requestVersionRef.current) return;

        setError(
          cause instanceof Error ? cause.message : 'Release notes are unavailable right now.'
        );
      } finally {
        if (loadMoreInFlightRef.current === request) loadMoreInFlightRef.current = null;
        if (requestVersion === requestVersionRef.current) setLoadingMore(false);
      }
    })();
    loadMoreInFlightRef.current = request;
    return request;
  }, [channel]);

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
