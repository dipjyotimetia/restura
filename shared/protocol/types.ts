import type { BodyType, FormField } from './body-builder';

/**
 * Auth configuration consumed by the shared protocol core.
 *
 * This is a structural subset of `AuthConfig` from `src/types/index.ts`. It
 * lives here (rather than being imported from `@/types`) so the shared core
 * has no compile-time dependency on the renderer source tree — keeping the
 * Worker bundle and Electron build self-contained.
 *
 * Sign-at-wire auth (currently AWS SigV4) is applied by `applyAuth` against
 * the exact body bytes the upstream receives. Other auth types (Bearer,
 * Basic, API-key, OAuth2) are still applied by the renderer before the
 * request reaches the proxy — they don't depend on wire-byte fidelity.
 */
export type ProtocolAuthType =
  | 'none'
  | 'basic'
  | 'bearer'
  | 'api-key'
  | 'oauth2'
  | 'digest'
  | 'aws-signature';

export interface ProtocolAuthConfig {
  type: ProtocolAuthType;
  awsSignature?: {
    accessKey: string;
    secretKey: string;
    region: string;
    service: string;
  };
  // Other auth shapes (basic/bearer/apiKey/oauth2/digest) intentionally omitted —
  // the shared core only needs to act on `aws-signature`. Passing through
  // unknown auth types is a no-op.
}

export interface RequestSpec {
  method: string;
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  bodyType?: BodyType;
  data?: string;
  formData?: FormField[];
  timeout?: number;
  /**
   * Auth that requires sign-at-wire fidelity (AWS SigV4 hashes the body bytes,
   * so the signature must be computed against the exact bytes the fetcher sends
   * — not a renderer-side reconstruction the worker may transform).
   *
   * Bearer / Basic / API-key / OAuth2 are still applied by the renderer before
   * the request reaches the proxy; they don't depend on wire-byte fidelity.
   */
  auth?: ProtocolAuthConfig;
}

export interface NormalizedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  size: number;
  /**
   * Negotiated ALPN protocol when known. The Worker doesn't have direct ALPN
   * visibility (the runtime negotiates), so this is populated only by Electron
   * (via undici) and surfaced informationally in the response viewer.
   */
  negotiatedAlpn?: 'h1.1' | 'h2' | 'h3';
}

export interface FetcherRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: BodyInit | undefined;
  signal: AbortSignal;
  /**
   * Hook for backend-specific extensions. Electron passes its proxy / mTLS / interceptor
   * config through here without the shared core caring. Worker fetcher ignores it.
   */
  backendOptions?: unknown;
}

export interface FetcherResponse {
  status: number;
  statusText: string;
  headers: Headers | Record<string, string | string[]>;
  /**
   * Buffered text body. Streaming responses are out of scope for Plan 1 (foundation);
   * Plan 4 (streaming) extends this contract with a streaming variant via `body`.
   */
  text: () => Promise<string>;
  contentLengthHeader: string | null;
  /**
   * Optional access to the raw response stream. When present, the shared core
   * may choose to stream-through instead of buffering via text(). Streaming
   * consumers MUST NOT also call text() on the same response (the body can
   * only be read once). Populated by fetchers that support streaming
   * (Worker fetch is always streamable; Electron's undici fetcher exposes it).
   */
  body?: ReadableStream<Uint8Array> | null;
  /** Negotiated ALPN for this response. Populated by Electron's undici fetcher. */
  negotiatedAlpn?: 'h1.1' | 'h2' | 'h3';
}

export type Fetcher = (req: FetcherRequest) => Promise<FetcherResponse>;

export interface ProtocolErrorPayload {
  error: string;
  status?: number;
}

export type ExecuteResult =
  | { ok: true; response: NormalizedResponse }
  | { ok: false; status: number; payload: ProtocolErrorPayload };
