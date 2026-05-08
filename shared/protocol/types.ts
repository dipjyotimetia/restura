import type { BodyType, FormField } from './body-builder';

export interface RequestSpec {
  method: string;
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  bodyType?: BodyType;
  data?: string;
  formData?: FormField[];
  timeout?: number;
}

export interface NormalizedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  size: number;
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
   * Plan 4 (streaming) extends this contract with a streaming variant.
   */
  text: () => Promise<string>;
  contentLengthHeader: string | null;
}

export type Fetcher = (req: FetcherRequest) => Promise<FetcherResponse>;

export interface ProtocolErrorPayload {
  error: string;
  status?: number;
}

export type ExecuteResult =
  | { ok: true; response: NormalizedResponse }
  | { ok: false; status: number; payload: ProtocolErrorPayload };
