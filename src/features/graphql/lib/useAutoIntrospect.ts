import { useEffect, useRef } from 'react';
import { useGraphQLSchemaStore } from '@/store/useGraphQLSchemaStore';
import type { HttpRequest } from '@/types';

/** Wait this long after the URL settles before auto-introspecting it. */
export const AUTO_INTROSPECT_DELAY_MS = 800;

/** An endpoint worth introspecting unprompted: an absolute http(s) URL or a `{{var}}` one. */
export const isIntrospectableUrl = (url: string): boolean =>
  /^https?:\/\/[^\s/]+/i.test(url.trim()) || /^\{\{[^}]+\}\}\S*$/.test(url.trim());

/**
 * Introspect (debounced, once per URL per mount) when a usable URL is set and
 * nothing is known about it yet — so autocomplete works without hunting for
 * the explorer's Refresh. An imported schema or any cached result (success or
 * failure) wins; explicit Refresh is how the user asks again.
 */
export function useAutoIntrospect(
  request: HttpRequest | null | undefined,
  hasImportedSchema: boolean
): void {
  const url = request?.url ?? '';
  const fetchSchema = useGraphQLSchemaStore((s) => s.fetchSchema);
  const known = useGraphQLSchemaStore((s) =>
    url ? s.schemas[url] !== undefined || (s.loading[url] ?? false) : false
  );
  const attempted = useRef(new Set<string>());
  const requestRef = useRef(request);
  requestRef.current = request;

  useEffect(() => {
    if (!url || hasImportedSchema || known) return;
    if (!isIntrospectableUrl(url) || attempted.current.has(url)) return;
    const timer = setTimeout(() => {
      const current = requestRef.current;
      if (!current || current.url !== url) return;
      attempted.current.add(url);
      void fetchSchema(url, { request: current });
    }, AUTO_INTROSPECT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [url, hasImportedSchema, known, fetchSchema]);
}
