import type { KnownHttpMethod } from '../protocol/http-method';
import type { AuthConfig } from './auth';
import type { KeyValue, MultipartPart } from './common';
import type { CaCert, ClientCert, MinTlsVersion, ProxyConfig } from './security';

// HTTP Methods — the seven well-known methods plus any RFC 9110 token
// (PROPFIND, QUERY, PURGE…). `string & {}` keeps literal autocomplete for the
// known set. Validation (token regex, CONNECT/TRACE/TRACK denylist) lives in
// shared/protocol/http-method.ts and is enforced at the wire (#857).
export type { KnownHttpMethod };
export type HttpMethod = KnownHttpMethod | (string & {});

/**
 * Per-request HTTP protocol version preference (#864). Desktop-only — the web
 * Worker's runtime owns protocol negotiation, so web always behaves as `auto`.
 *  - `auto`: ALPN offers h2 + http/1.1 over TLS; cleartext is HTTP/1.1.
 *  - `http1.1`: ALPN offers http/1.1 only (debug h2-specific server bugs).
 *  - `http2`: TLS requires ALPN h2 (fails if the server can't); cleartext
 *    uses h2c prior knowledge (there is no h2c Upgrade path in undici).
 *  - `h2c-prior-knowledge`: cleartext HTTP/2 without Upgrade (RFC 9113 §3.3);
 *    on an https: URL it behaves like `http2`.
 */
export const HTTP_VERSION_PREFERENCES = [
  'auto',
  'http1.1',
  'http2',
  'h2c-prior-knowledge',
] as const;
export type HttpVersionPreference = (typeof HTTP_VERSION_PREFERENCES)[number];

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

/**
 * GraphQL subscription wire protocol (#889).
 * - `auto` — WebSocket offering both `graphql-transport-ws` and the legacy
 *   `graphql-ws` subprotocol; dispatch on the one the server selects.
 * - `graphql-transport-ws` — the modern graphql-ws protocol.
 * - `subscriptions-transport-ws` — Apollo's legacy protocol (subprotocol `graphql-ws`).
 * - `graphql-sse` — GraphQL over Server-Sent Events (distinct connections mode).
 */
export const GRAPHQL_SUBSCRIPTION_PROTOCOLS = [
  'auto',
  'graphql-transport-ws',
  'subscriptions-transport-ws',
  'graphql-sse',
] as const;
export type GraphQLSubscriptionProtocol = (typeof GRAPHQL_SUBSCRIPTION_PROTOCOLS)[number];

// Request Body Type (extracted for reusability)
export interface RequestBody {
  type: BodyType;
  raw?: string;
  /** Persisted GraphQL variables JSON for a GraphQL body; never used by other body types. */
  graphqlVariables?: string;
  /**
   * GraphQL only: the operation selected in a multi-operation document. Sent
   * as `operationName` (HTTP and subscriptions); a stale name falls back to
   * the document's first operation.
   */
  graphqlOperationName?: string;
  formData?: FormDataItem[];
  binary?: File;
  multipartParts?: MultipartPart[];
}

/**
 * A GraphQL schema the user loaded by hand (SDL file, pasted SDL or an
 * introspection JSON result) for endpoints that disable introspection.
 * Stored as canonical SDL — introspection JSON is converted on import — so
 * persisted tabs/collections stay compact and diffable.
 */
export interface GraphQLImportedSchema {
  sdl: string;
  /** What the user supplied: SDL text/file or an introspection JSON result. */
  source: 'sdl' | 'introspection';
  fileName?: string;
  /** Epoch ms of the import. */
  importedAt: number;
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
  settings?: RequestSettingsOverride;
  /**
   * Human-readable, markdown documentation for this request. Surfaced in
   * generated collection docs (see docGenerator) and editable in the request
   * builder. The AI "Enrich docs" action writes here via the `enrich_docs` tool.
   */
  description?: string;
  /**
   * Optional link from this request to an OpenAPI operation. The
   * `operationId` matches an `operationId` in the spec attached at
   * collection/folder level via `Collection.contractSpec`. NOTE: nothing
   * reads this at execution time yet — the contracts validator
   * (`src/features/contracts/lib/validator.ts`) is built and tested but not
   * wired into the request executor.
   */
  contractRef?: {
    operationId: string;
  };
  /**
   * GraphQL only: a schema imported by the user. When present it takes
   * precedence over the introspection cache for autocomplete, validation and
   * the schema explorer; re-introspecting replaces it only after the user
   * confirms.
   */
  graphqlSchema?: GraphQLImportedSchema;
  /**
   * GraphQL only: wire protocol for subscriptions. Absent means `'auto'`
   * (offer both WebSocket subprotocols and follow the server's pick).
   */
  graphqlSubscriptionProtocol?: GraphQLSubscriptionProtocol;
}

// Response
export interface Response {
  id: string;
  requestId: string;
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  /**
   * Every `Set-Cookie` field, one entry each (RFC 6265 §3 — never folded).
   * `headers` is a flat map and holds at most one/joined value; this list is
   * authoritative for the cookie jar and the Headers view.
   */
  setCookies?: string[];
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
  /**
   * Why the body is shown undecoded, when it is — e.g. the desktop fetcher met
   * an unsupported Content-Encoding and kept the raw bytes. Shown above the body.
   */
  bodyNotice?: string;
  /**
   * True on a provisional response that is still arriving — a GraphQL
   * `@defer` / `@stream` result rendered part by part. The viewer shows it in
   * place of the loading skeleton; the complete response replaces it.
   */
  partial?: boolean;
  /**
   * Where the time went, as measured by the proxy core: time to headers and
   * body download everywhere; DNS and connect (incl. TLS) on desktop direct
   * connections. Absent for responses that predate it. `time` stays the
   * end-to-end total seen by the client.
   */
  timings?: {
    dns?: number;
    connect?: number;
    ttfb: number;
    download: number;
  };
  /**
   * MCP collection runs only (#901): how the JSON-RPC call ended. The HTTP
   * envelope is always 200, so the runner reads this for its default verdict
   * (`tool-error` / `jsonrpc-error` fail unless test assertions decide).
   */
  mcpOutcome?: 'result' | 'tool-error' | 'jsonrpc-error';
}

// Request Settings (per-request configuration)
//
/**
 * A request's settings override. Partial: omitted fields follow the workspace
 * defaults at send time (`resolveEffectiveSettings`). The Settings editor seeds
 * a full object when the user turns the override on; importers may carry only
 * the fields they know (e.g. `httpVersion` from `x-restura-http`).
 */
export type RequestSettingsOverride = Partial<RequestSettings>;

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

  // --- Protocol version (desktop-only; honoured by the Electron undici dispatcher) ---
  /** HTTP version preference. Omitted ≡ 'auto'. */
  httpVersion?: HttpVersionPreference;
}
