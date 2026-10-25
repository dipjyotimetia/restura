// Capability rows: HTTP / REST, plus GraphQL (which rides the HTTP proxy).
// Order is significant: it is the row order of docs/CAPABILITY_MATRIX.md.
import type { CapabilityRow } from './types';

export const HTTP_CAPABILITIES = {
  'http.basic': {
    label: 'HTTP / REST requests',
    web: true,
    desktop: true,
    notes:
      'Hosted web (Cloudflare Workers) sends only the runtime fixed method list (standard, WebDAV, PURGE, QUERY and a few more), upper-cased; other extension methods need desktop or self-host',
  },
  'graphql.basic': {
    label: 'GraphQL query / mutation',
    web: true,
    desktop: true,
    notes:
      'Rides the HTTP proxy: POST { query, variables, operationName } or, for queries, GET with them URL-encoded; sends Accept: application/graphql-response+json, application/json;q=0.9',
  },
  'graphql.incrementalDelivery': {
    label: 'GraphQL @defer / @stream (multipart/mixed incremental delivery)',
    web: true,
    desktop: true,
    notes:
      'Both merge the multipart parts into one result. Web renders each part as it arrives (Worker streaming pass-through); desktop shows the merged result once the response completes (Electron HTTP IPC buffers)',
  },
  'http.proxy.socks': {
    label: 'SOCKS5 proxy',
    web: false,
    desktop: true,
    notes: 'Browser fetch cannot route through SOCKS',
  },
  'http.proxy.pac': {
    label: 'PAC proxy script resolution',
    web: false,
    desktop: false,
    notes:
      'Not wired end-to-end: the renderer ProxyType cannot emit a PAC proxy and the PAC script is never loaded via session.setProxy — only handler scaffolding exists. Marked unsupported until the renderer + setProxy path land.',
  },
  'http.mtls': {
    label: 'mTLS client certificates',
    web: false,
    desktop: true,
    notes: 'Web build inherits browser cert store; no per-request control',
  },
  'http.customCa': { label: 'Custom CA bundle', web: false, desktop: true },
  'http.manualRedirect': { label: 'Manual redirect handling', web: true, desktop: true },
  'http.connectionTimings': {
    label: 'DNS / connect timing breakdown',
    web: false,
    desktop: true,
    notes:
      'Both show time to headers, download and the remaining overhead; DNS and connect (incl. TLS) are measured only on desktop direct connections, not through proxies',
  },
  'http.dnsPinning': {
    label: 'DNS-pinning SSRF guard',
    web: false,
    desktop: true,
    notes: 'Browser fetch resolves DNS opaquely',
  },
  'http.tls.cipherSuite': {
    label: 'TLS cipher suite + server-order control',
    web: false,
    desktop: true,
    notes: 'No per-request TLS handshake control in Cloudflare Workers / browsers',
  },
  'http.tls.minVersion': {
    label: 'TLS minimum protocol version',
    web: false,
    desktop: true,
    notes: "Web client uses the runtime's default TLS floor",
  },
  'http.version': {
    label: 'HTTP version control (force HTTP/1.1, HTTP/2, h2c prior knowledge)',
    web: false,
    desktop: true,
    notes:
      'Web always negotiates via the runtime (Auto). h2c prior knowledge works direct and through SOCKS, not through an HTTP proxy',
  },
  'http.streamingResponse': {
    label: 'Incremental HTTP response streaming',
    web: true,
    desktop: false,
    notes:
      'Web streams via the Worker proxy; Electron IPC buffers the full response (renderer falls back to the buffered path)',
  },
} as const satisfies Record<string, CapabilityRow>;
