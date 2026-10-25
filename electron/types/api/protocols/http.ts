// HTTP request/response IPC types (`window.electron.http`).

import type { ProtocolSecretValue } from './shared';

export interface ElectronHttpProxyConfig {
  enabled: boolean;
  type: 'http' | 'https' | 'socks4' | 'socks5' | 'pac';
  host: string;
  port: number;
  pacUrl?: string;
  auth?: {
    username: string;
    // SecretValue (ADR-0007) — resolved to plaintext in the main process.
    password: ProtocolSecretValue;
  };
}

export interface ElectronHttpClientCert {
  format: 'pfx' | 'pem';
  pfx?: string;
  cert?: string;
  key?: string;
  passphrase?: ProtocolSecretValue;
}

export interface ElectronHttpCaCert {
  pem: string;
}

export interface ElectronHttpFormField {
  name: string;
  value: string;
  // `| undefined` (not bare `?`) so the Zod-inferred ProxyRequestBody.formData
  // assigns cleanly under exactOptionalPropertyTypes.
  filename?: string | undefined;
  contentType?: string | undefined;
}

export interface ElectronHttpRequestConfig {
  requestId: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  data?: string;
  // Structured body (drives the shared body-builder): binary base64 rides in
  // `data` with bodyType:'binary'; multipart fields ride in `formData`.
  bodyType?: 'none' | 'json' | 'text' | 'raw' | 'form-urlencoded' | 'form-data' | 'binary';
  formData?: ElectronHttpFormField[];
  timeout?: number;
  maxRedirects?: number;
  proxy?: ElectronHttpProxyConfig;
  verifySsl?: boolean;
  clientCert?: ElectronHttpClientCert;
  caCert?: ElectronHttpCaCert;
  // Redirect / URL handling (cross-platform)
  followOriginalMethod?: boolean;
  followAuthHeader?: boolean;
  stripReferer?: boolean;
  encodeUrlAutomatically?: boolean;
  // TLS (desktop-only enforcement; mirrors HttpRequestConfigSchema)
  serverCipherOrder?: boolean;
  minTlsVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
  cipherSuites?: string;
  // HTTP version preference (#864; desktop-only)
  httpVersion?: import('../../../../shared/types/http').HttpVersionPreference;
}

export interface ElectronHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Every Set-Cookie field, one entry each (RFC 6265 §3 — never folded). */
  setCookies?: string[];
  data: unknown;
  /** Decoded byte size of the response body. */
  size?: number;
  /** 'base64' when `data` is base64 of a binary body (see shared/protocol/binary.ts). */
  bodyEncoding?: 'base64';
  /**
   * Negotiated ALPN protocol from undici (h2 / h1.1 / h3 when available).
   * Surfaced by the renderer as a small "HTTP/2" / "HTTP/1.1" badge.
   */
  negotiatedAlpn?: 'h1.1' | 'h2' | 'h3';
  /** Why the body was left undecoded (e.g. unsupported Content-Encoding), when it was. */
  bodyNotice?: string;
  /** Timing breakdown of the final hop (shared/protocol ResponseTimings). */
  timings?: import('../../../../shared/protocol/types').ResponseTimings;
}

export interface ElectronHttpAPI {
  request: (config: ElectronHttpRequestConfig) => Promise<ElectronHttpResponse>;
  cancel: (args: {
    requestId: string;
  }) => Promise<{ ok: true; alreadyDone?: true } | { ok: false; error: string }>;
}
