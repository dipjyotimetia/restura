# ADR 0019: Response Viewer Architecture

**Status:** Accepted, 2026-04-29

## Context

Restura renders two fundamentally different kinds of response. A normal HTTP/gRPC-unary response is a finite blob you want to pretty-print, fold, and search. A streaming response (SSE, NDJSON, gRPC server-streaming — see [ADR 0003](./0003-streaming-and-http2.md)) is an unbounded, growing sequence of events that must appear incrementally and could, over a long-lived stream, exhaust memory or lock up the UI if naively accumulated into one editor buffer.

## Decision

Split the viewer by response kind:

- **Buffered responses** render in **Monaco Editor** — syntax highlighting, folding, and find for finite JSON/text/XML bodies.
- **Streaming responses** render in a dedicated incremental viewer (`src/components/shared/StreamingResponseViewer.tsx`, fed by `src/features/http/lib/streamingResponseReader.ts`) that appends events as they arrive and **caps the retained events at 5000** to keep memory and DOM bounded on long streams. Older events roll off once the cap is hit.

Monaco is deliberately _not_ used for streams: re-tokenising a growing buffer on every event is the failure mode this split avoids.

## Consequences

**Positive**

- Finite bodies get full editor ergonomics; long streams stay responsive and memory-bounded.
- The event cap prevents an indefinite stream from degrading the whole app.

**Negative**

- The 5000-event cap means very long streams lose their earliest events from the UI; users who need the full record should capture it another way (e.g. the CLI or a script).
- Two viewer implementations to maintain, each with its own copy/search behaviour.

## References

- Code: `src/components/shared/StreamingResponseViewer.tsx`, `src/features/http/lib/streamingResponseReader.ts`
- Related: [ADR 0003 (streaming + HTTP/2)](./0003-streaming-and-http2.md)
