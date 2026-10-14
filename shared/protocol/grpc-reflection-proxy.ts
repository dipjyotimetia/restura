/**
 * gRPC server reflection over the Connect protocol, for the HTTP backends
 * (Cloudflare Worker + Node self-host) behind `/api/grpc/reflection`.
 *
 * `grpc.reflection.{v1,v1alpha}.ServerReflection/ServerReflectionInfo` is a
 * bidi-streaming RPC, so a standard Connect server only accepts it with the
 * Connect *streaming* framing: `application/connect+json` and 5-byte
 * enveloped messages, terminated by an end-stream envelope that carries any
 * RPC error. Posting un-enveloped `application/json` (the pre-#875 behaviour)
 * is answered with 415 by every real Connect server.
 *
 * We send one enveloped request (the body ends, which half-closes the stream),
 * read the response envelopes with a byte cap, and return the first message.
 * Connect servers refuse bidi streams over HTTP/1.1 (505), so the upstream
 * hop must negotiate HTTP/2 — the Node entry injects an h2-capable fetch;
 * Electron does not use this path (it speaks native gRPC via connect-node).
 */
import { readStreamToBytes } from './binary';
import type { GrpcReflectionRequestBody } from './grpc-schema';
import { MAX_RESPONSE_SIZE } from './http-proxy';
import type { Fetcher, FetcherResponse } from './types';
import { validateURL } from './url-validation';

export const REFLECTION_SERVICE_V1 = 'grpc.reflection.v1.ServerReflection';
export const REFLECTION_SERVICE_V1_ALPHA = 'grpc.reflection.v1alpha.ServerReflection';

const DEFAULT_TIMEOUT_MS = 30_000;
const ENVELOPE_HEADER_BYTES = 5;
const FLAG_COMPRESSED = 0b01;
const FLAG_END_STREAM = 0b10;

export type GrpcReflectionSpec = GrpcReflectionRequestBody;

export interface ExecuteGrpcReflectionOptions {
  allowLocalhost: boolean;
  allowPrivateIPs?: boolean;
}

export type GrpcReflectionResult =
  | { ok: true; response: Record<string, unknown> & { reflectionVersion: 'v1' | 'v1alpha' } }
  | { ok: false; status: number; payload: { error: string; grpcStatusText?: string } };

/** The upstream spoke, but its body crossed `MAX_RESPONSE_SIZE`. */
class ReflectionTooLargeError extends Error {
  constructor() {
    super(`Response size exceeds maximum limit of ${MAX_RESPONSE_SIZE / 1024 / 1024}MB`);
    this.name = 'ReflectionTooLargeError';
  }
}

/** Wrap one JSON message in a Connect streaming envelope (flags=0). */
export function encodeConnectEnvelope(message: unknown, flags = 0): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const out = new Uint8Array(ENVELOPE_HEADER_BYTES + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, flags);
  view.setUint32(1, payload.byteLength, false);
  out.set(payload, ENVELOPE_HEADER_BYTES);
  return out;
}

interface ConnectEndStream {
  error?: { code?: string; message?: string };
}

/**
 * Split a Connect streaming body into its data messages, throwing on a
 * truncated envelope, a compressed envelope (we never advertise an encoding),
 * or an end-stream envelope that carries an RPC error.
 */
export function decodeConnectStream(bytes: Uint8Array): unknown[] {
  const decoder = new TextDecoder();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const messages: unknown[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + ENVELOPE_HEADER_BYTES > bytes.byteLength) {
      throw new Error('Malformed Connect stream: truncated envelope header');
    }
    const flags = view.getUint8(offset);
    const length = view.getUint32(offset + 1, false);
    const start = offset + ENVELOPE_HEADER_BYTES;
    const end = start + length;
    if (end > bytes.byteLength) {
      throw new Error('Malformed Connect stream: truncated envelope payload');
    }
    if (flags & FLAG_COMPRESSED) {
      throw new Error('Connect stream used compression, which was not negotiated');
    }
    const json = length === 0 ? {} : JSON.parse(decoder.decode(bytes.subarray(start, end)));
    if (flags & FLAG_END_STREAM) {
      const err = (json as ConnectEndStream).error;
      if (err) {
        throw new Error(`${err.code ?? 'unknown'}: ${err.message ?? 'reflection RPC failed'}`);
      }
      return messages;
    }
    messages.push(json);
    offset = end;
  }
  // A well-formed stream always ends with an end-stream envelope.
  throw new Error('Malformed Connect stream: missing end-stream message');
}

/** Read the response bytes with the size cap applied while streaming. */
async function readBoundedBytes(response: FetcherResponse): Promise<Uint8Array> {
  if (response.body) {
    const bytes = await readStreamToBytes(response.body, MAX_RESPONSE_SIZE);
    if (bytes === null) throw new ReflectionTooLargeError();
    return bytes;
  }
  if (response.arrayBuffer) {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > MAX_RESPONSE_SIZE) throw new ReflectionTooLargeError();
    return new Uint8Array(buf);
  }
  // text() would UTF-8-decode the binary envelope headers and corrupt them.
  throw new Error('Fetcher exposes no binary body for a Connect stream');
}

function httpFailureMessage(status: number, statusText: string): string {
  const base = `HTTP ${status}${statusText ? ` ${statusText}` : ''}`;
  if (status === 505) {
    return `${base} — the server requires HTTP/2 for bidi-streaming reflection`;
  }
  if (status === 415) {
    return `${base} — the server does not accept the Connect protocol (gRPC-only servers need the desktop app)`;
  }
  return base;
}

function headerValue(headers: FetcherResponse['headers'], name: string): string {
  // Duck-typed: an npm-undici Response carries its own Headers class, which
  // fails `instanceof` against the runtime's global Headers.
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? '';
  for (const [k, v] of Object.entries(headers as Record<string, string | string[]>)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v.join(', ') : v;
  }
  return '';
}

async function reflectOnce(
  fetcher: Fetcher,
  baseUrl: string,
  serviceName: string,
  spec: GrpcReflectionSpec,
  timeout: number
): Promise<Record<string, unknown>> {
  const url = `${baseUrl.replace(/\/$/, '')}/${serviceName}/ServerReflectionInfo`;
  const headers = new Headers();
  headers.set('content-type', 'application/connect+json');
  headers.set('connect-protocol-version', '1');
  headers.set('connect-timeout-ms', String(timeout));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetcher({
      url,
      method: 'POST',
      headers,
      body: encodeConnectEnvelope(spec.request),
      signal: controller.signal,
    });
    if (response.status !== 200) {
      // Don't keep the connection's body alive; the status says it all.
      await response.body?.cancel().catch(() => undefined);
      throw new Error(httpFailureMessage(response.status, response.statusText));
    }
    if (Number(response.contentLengthHeader) > MAX_RESPONSE_SIZE) {
      throw new ReflectionTooLargeError();
    }
    const contentType = headerValue(response.headers, 'content-type').toLowerCase();
    if (!contentType.startsWith('application/connect+json')) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Unexpected reflection content-type "${contentType || 'none'}"`);
    }
    const [first] = decodeConnectStream(await readBoundedBytes(response));
    if (!first || typeof first !== 'object') {
      throw new Error('Reflection stream ended without a response message');
    }
    return first as Record<string, unknown>;
  } catch (err) {
    if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
      throw new Error('Reflection request timed out');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function tooLarge(err: ReflectionTooLargeError): GrpcReflectionResult {
  return {
    ok: false,
    status: 413,
    payload: { error: err.message, grpcStatusText: 'RESOURCE_EXHAUSTED' },
  };
}

/**
 * Run one reflection query, trying v1 then falling back to v1alpha. A body
 * over the size cap short-circuits to 413 (the server answered, retrying the
 * other version would only re-download it).
 */
export async function executeGrpcReflectionProxy(
  spec: GrpcReflectionSpec,
  fetcher: Fetcher,
  options: ExecuteGrpcReflectionOptions
): Promise<GrpcReflectionResult> {
  const validation = validateURL(spec.url, {
    allowPrivateIPs: options.allowPrivateIPs === true,
    allowLocalhost: options.allowLocalhost,
  });
  if (!validation.valid) {
    return { ok: false, status: 400, payload: { error: `Invalid URL: ${validation.error}` } };
  }
  const timeout = spec.timeout ?? DEFAULT_TIMEOUT_MS;

  let v1Error: unknown;
  try {
    const message = await reflectOnce(fetcher, spec.url, REFLECTION_SERVICE_V1, spec, timeout);
    return { ok: true, response: { ...message, reflectionVersion: 'v1' } };
  } catch (err) {
    if (err instanceof ReflectionTooLargeError) return tooLarge(err);
    v1Error = err;
  }
  try {
    const message = await reflectOnce(
      fetcher,
      spec.url,
      REFLECTION_SERVICE_V1_ALPHA,
      spec,
      timeout
    );
    return { ok: true, response: { ...message, reflectionVersion: 'v1alpha' } };
  } catch (alphaErr) {
    if (alphaErr instanceof ReflectionTooLargeError) return tooLarge(alphaErr);
    const v1Msg = v1Error instanceof Error ? v1Error.message : String(v1Error);
    const alphaMsg = alphaErr instanceof Error ? alphaErr.message : String(alphaErr);
    return {
      ok: false,
      status: 500,
      payload: { error: `Reflection failed on v1 (${v1Msg}) and v1alpha (${alphaMsg})` },
    };
  }
}
