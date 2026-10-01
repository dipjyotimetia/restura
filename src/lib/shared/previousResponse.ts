import { buildDisplayUrl } from '@/features/http/lib/urlQuery';
import type { ConsoleEntry } from '@/store/useConsoleStore';
import type { HistoryItem, Response } from '@/types';

/**
 * The history entry holding the response before `current` for the same
 * request (matched by request id; history is newest-first). Undefined when
 * there's nothing earlier to compare with.
 */
export function previousHistoryItem(
  history: readonly HistoryItem[],
  requestId: string,
  current: Pick<Response, 'id' | 'timestamp'>
): HistoryItem | undefined {
  return history.find(
    (item) =>
      item.request.id === requestId &&
      item.response !== undefined &&
      item.response.id !== current.id &&
      item.response.timestamp < current.timestamp
  );
}

/** Shape a history entry (or the live response) for the console's compare dialog. */
export function toCompareEntry(
  item: Pick<HistoryItem, 'request' | 'timestamp' | 'resolvedUrl'> & { id: string },
  response: Response
): ConsoleEntry {
  const r = item.request;
  const headers: Record<string, string> = {};
  if ('headers' in r && Array.isArray(r.headers)) {
    for (const h of r.headers) if (h.enabled && h.key) headers[h.key] = h.value;
  }
  const body =
    r.type === 'http' && r.body.type !== 'none' && r.body.raw !== undefined
      ? r.body.raw
      : undefined;
  return {
    id: item.id,
    timestamp: item.timestamp,
    protocol: 'http',
    request: {
      method: r.type === 'http' ? r.method : r.type.toUpperCase(),
      // The resolved URL when known (history records it without the query),
      // plus the query, which the stored request keeps in `params`.
      url:
        r.type === 'http'
          ? buildDisplayUrl(item.resolvedUrl ?? r.url, r.params)
          : (item.resolvedUrl ?? r.url),
      headers,
      ...(body !== undefined && { body }),
    },
    response: { ...response, body: prettyForDiff(response.body) },
  };
}

/** Bodies above this aren't reformatted (parsing would stall the dialog). */
const DIFF_FORMAT_MAX = 1_000_000;

/**
 * Pretty-print a JSON body so the line diff shows the fields that changed,
 * not one changed minified line. Non-JSON or oversized bodies pass through.
 */
export function prettyForDiff(body: string): string {
  if (body.length > DIFF_FORMAT_MAX) return body;
  const trimmed = body.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return body;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
