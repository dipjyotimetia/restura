/**
 * A chunked (no content-length) upstream body that would grow without bound.
 * `pulled` counts chunks handed out so a test can prove the reader stopped at
 * the byte cap instead of draining the upstream; `cancelled` flips when the
 * reader gives up on the stream.
 */
export function endlessChunkedBody(chunkBytes = 64 * 1024) {
  const state = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(chunkBytes).fill(0x61);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled++;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

/** 10MB cap / 64KB chunks ≈ 161 pulls, plus a little stream prefetch slack. */
export const MAX_PULLS_FOR_10MB_CAP = 170;
