/**
 * Accept-header media types that make a response a stream: the ones the HTTP
 * page renders live, and the ones the web proxy answers with a raw
 * pass-through instead of the buffered JSON envelope.
 */
/** Accept-header content types the HTTP page renders as a live stream. */
const STREAMING_ACCEPT_TYPES = new Set([
  'text/event-stream',
  'application/x-ndjson',
  'application/jsonl',
]);

/**
 * Accept media types the web proxy answers with a raw streaming pass-through
 * (`worker/handlers/proxy.ts` `STREAMING_MEDIA_TYPES`) instead of the buffered
 * JSON envelope. Keep in sync with the Worker.
 */
const PROXY_STREAMED_ACCEPT_TYPES = new Set([...STREAMING_ACCEPT_TYPES, 'application/grpc-web']);

function acceptMediaTypes(headers: Record<string, string>): string[] {
  const accept = Object.entries(headers).find(([k]) => k.toLowerCase() === 'accept')?.[1] ?? '';
  return accept
    .split(',')
    .map((entry) => (entry.split(';')[0] ?? '').trim().toLowerCase())
    .filter(Boolean);
}

export function proxyStreamsAccept(headers: Record<string, string>): boolean {
  return acceptMediaTypes(headers).some((t) => PROXY_STREAMED_ACCEPT_TYPES.has(t));
}

export function ignoreProgress(): void {}

/**
 * Returns true when the supplied request headers ask for a streaming
 * content type (SSE / NDJSON / JSON Lines). Header lookup is
 * case-insensitive; compound Accept values (e.g. `text/event-stream,
 * application/json`) match if any element is a streaming type. Media types
 * are matched exactly (parameters ignored), as the Worker does.
 */
export function isStreamingAccept(headers: Record<string, string>): boolean {
  return acceptMediaTypes(headers).some((t) => STREAMING_ACCEPT_TYPES.has(t));
}
