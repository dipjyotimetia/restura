import { encodeConnectEnvelope } from '@shared/protocol/grpc-reflection-proxy';

/**
 * A Connect streaming response: each message in its own envelope, then the
 * end-stream envelope (flags=0b10) carrying an optional RPC error.
 */
export function connectStreamResponse(
  message: unknown,
  endStream: { error?: { code: string; message: string } } = {}
): Response {
  const parts = [
    ...(message === undefined ? [] : [encodeConnectEnvelope(message)]),
    encodeConnectEnvelope(endStream, 0b10),
  ];
  const body = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    body.set(p, offset);
    offset += p.byteLength;
  }
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/connect+json' },
  });
}
