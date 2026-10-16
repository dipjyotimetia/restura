import { useEffect, useMemo, useRef, useState } from 'react';
import { regexSearchTexts, type StreamEvent } from '@/lib/shared/stream-timeline';
import {
  createRegexRunner,
  type RegexRunner,
  validateTimelineRegex,
} from '@/lib/shared/timeline-regex';
import { createTimelineRegexWorker } from '@/lib/shared/timeline-regex-worker-factory';

export interface TimelineRegexState {
  /** Pattern rejected up front, or the worker search failed / timed out. */
  error: string | null;
  /** A worker search is running. */
  pending: boolean;
  /** Matcher over results known so far (unsearched events don't match yet). */
  match: (event: StreamEvent) => boolean;
}

const matchAll = () => true;

/**
 * Regex-mode search for the timeline. Matching runs in a time-boxed worker
 * (see `timeline-regex.ts`), never on the main thread. Results are cached per
 * event id for the current pattern, so a timeline flush only sends newly
 * arrived events. At most one search per pattern is in flight: new events
 * wait for it rather than superseding it, so a busy stream can't starve the
 * search or dodge the time budget.
 */
export function useTimelineRegexMatches(
  events: StreamEvent[],
  query: string,
  enabled: boolean
): TimelineRegexState {
  const pattern = enabled ? query.trim() : '';
  const rejection = useMemo(() => (pattern ? validateTimelineRegex(pattern) : null), [pattern]);
  const runnerRef = useRef<RegexRunner | null>(null);
  const inflightRef = useRef<string | null>(null);
  const cacheRef = useRef<{ pattern: string; matches: Map<string, boolean> }>({
    pattern: '',
    matches: new Map(),
  });
  const [version, setVersion] = useState(0);
  const [failure, setFailure] = useState<{ pattern: string; error: string } | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(
    () => () => {
      runnerRef.current?.dispose();
      runnerRef.current = null;
    },
    []
  );

  // `version` re-runs the search for events that arrived while one was in flight.
  useEffect(() => {
    if (!pattern || rejection || failure?.pattern === pattern) return;
    if (inflightRef.current === pattern) return;
    if (cacheRef.current.pattern !== pattern) {
      cacheRef.current = { pattern, matches: new Map() };
    }
    const cache = cacheRef.current;
    const todo = events.filter((e) => !cache.matches.has(e.id));
    if (todo.length === 0) return;
    runnerRef.current ??= createRegexRunner(createTimelineRegexWorker);
    inflightRef.current = pattern;
    setPending(true);
    void runnerRef.current.match(pattern, todo.flatMap(regexSearchTexts)).then((result) => {
      // Superseded by a newer pattern, which now owns the in-flight slot.
      if (!result.ok && result.cancelled) return;
      inflightRef.current = null;
      setPending(false);
      if (!result.ok) {
        setFailure({ pattern, error: result.error });
        return;
      }
      todo.forEach((e, i) => {
        cache.matches.set(
          e.id,
          result.results[2 * i] === true || result.results[2 * i + 1] === true
        );
      });
      setVersion((v) => v + 1);
    });
  }, [events, pattern, rejection, failure, version]);

  // `version` bumps when the cache fills, rebuilding the matcher.
  const match = useMemo(() => {
    if (!pattern || rejection) return matchAll;
    const matches = cacheRef.current.pattern === pattern ? cacheRef.current.matches : null;
    return (e: StreamEvent) => matches?.get(e.id) === true;
  }, [pattern, rejection, version]);

  const error = rejection ?? (failure?.pattern === pattern ? failure.error : null);
  return { error, pending: pending && !error && pattern !== '', match };
}
