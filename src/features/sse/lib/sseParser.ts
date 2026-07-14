/**
 * Renderer entry point for the SSE compatibility shim. The shim's string-based
 * `feed(chunk, callback)` API (with `lastEventId` carry) and the `parseSseStream`
 * one-shot helper now live once in `@shared/protocol/sse-stream-reader`; this
 * module re-exports them under the renderer's existing names so callsites in
 * `sseManager` and tests don't change.
 */

export {
  type ParsedSseEvent,
  parseSseStream,
  SseStreamReader as SseParser,
} from '@shared/protocol/sse-stream-reader';
