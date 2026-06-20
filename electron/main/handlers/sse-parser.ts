// Electron entry point for the SSE compatibility shim. The string/callback
// wrapper (used by sse-handler and mcp-handler) now lives once in
// @shared/protocol/sse-stream-reader; re-exported here under the existing
// `SseParser` name so consumers don't change.

export {
  SseStreamReader as SseParser,
  type ParsedSseEvent,
} from '@shared/protocol/sse-stream-reader';
