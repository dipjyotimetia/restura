import type { AuthConfig } from './auth';
import type { KeyValue, MultipartPart } from './common';
import type { ClientCert, CaCert, ProxyConfig, MinTlsVersion } from './security';

// HTTP Methods
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD';

// Body Types
export type BodyType =
  | 'none'
  | 'json'
  | 'xml'
  | 'form-data'
  | 'x-www-form-urlencoded'
  | 'binary'
  | 'protobuf'
  | 'graphql'
  | 'text'
  | 'multipart-mixed';

// Form Data
export interface FormDataItem extends KeyValue {
  type: 'text' | 'file';
  // For `type: 'file'`, the picked file's base64-encoded bytes live in `value`;
  // these carry the multipart filename + MIME so the built wire body is correct.
  fileName?: string;
  contentType?: string;
}

// Request Body Type (extracted for reusability)
export interface RequestBody {
  type: BodyType;
  raw?: string;
  formData?: FormDataItem[];
  binary?: File;
  multipartParts?: MultipartPart[];
}

// HTTP Request
export interface HttpRequest {
  id: string;
  name: string;
  type: 'http';
  method: HttpMethod;
  url: string;
  headers: KeyValue[];
  params: KeyValue[];
  body: RequestBody;
  auth: AuthConfig;
  preRequestScript?: string;
  testScript?: string;
  settings?: RequestSettings;
  /**
   * Human-readable, markdown documentation for this request. Surfaced in
   * generated collection docs (see docGenerator) and editable in the request
   * builder. The AI "Enrich docs" action writes here via the `enrich_docs` tool.
   */
  description?: string;
  /**
   * Optional link from this request to an OpenAPI operation. Lets the
   * contracts feature validate response shape at execution time. The
   * `operationId` matches an `operationId` in the spec attached at
   * collection/folder level via `Collection.contractSpec`.
   */
  contractRef?: {
    operationId: string;
  };
}

// Response
export interface Response {
  id: string;
  requestId: string;
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  body: string;
  size: number;
  time: number;
  timestamp: number;
  /**
   * How `body` is encoded. Absent means `body` is response text as-is.
   * 'base64' means the upstream returned a binary content type and `body` holds
   * the base64 of the raw bytes (decode before use, e.g. for image preview).
   */
  bodyEncoding?: 'base64';
  /**
   * Negotiated ALPN protocol when known. Populated by Electron's undici fetcher;
   * absent for the worker path (CF runtime doesn't expose ALPN).
   */
  negotiatedAlpn?: 'h1.1' | 'h2' | 'h3';
}

// Request Settings (per-request configuration)
//
// NOTE: the redirect-policy fields below are mirrored as `RedirectPolicy` in
// `shared/protocol/types.ts`. They must move in lockstep — the parity test
// `tests/redirect-policy-parity.test.ts` guards against drift.
export interface RequestSettings {
  timeout: number; // in milliseconds
  followRedirects: boolean;
  maxRedirects: number;
  verifySsl: boolean;
  proxy?: ProxyConfig;
  clientCert?: ClientCert;
  caCert?: CaCert;

  // --- redirect policy (cross-platform; honoured by shared/protocol/redirect-follower) ---
  /** If true, 301/302 redirects preserve the original method (RFC-compliant). Default: false (legacy: downgrade non-HEAD to GET). */
  followOriginalMethod?: boolean;
  /** If true, the Authorization header is preserved on cross-origin redirects. Default: false (stripped). */
  followAuthHeader?: boolean;
  /** If true, the Referer header is removed on every redirect hop. Default: false (preserved unless cross-origin policy strips it). */
  stripReferer?: boolean;

  // --- URL handling (cross-platform) ---
  /** If true (default behaviour), percent-encode path/query via WHATWG URL. If false, emit raw bytes — useful for upstreams that reject %-encoding. */
  encodeUrlAutomatically?: boolean;

  // --- Cookies (renderer-side; cross-platform) ---
  /** If true, skip cookie-jar read/write for this request. Default: false. */
  disableCookieJar?: boolean;

  // --- TLS knobs (desktop-only; honoured by Electron undici / tls.connect) ---
  /** If true, the server's cipher-suite order takes precedence (TLS honorCipherOrder). */
  serverCipherOrder?: boolean;
  /** Lower bound for TLS protocol. Omit to use Node's default. */
  minTlsVersion?: MinTlsVersion;
  /** OpenSSL-format cipher list, e.g. "ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384". */
  cipherSuites?: string;
}
