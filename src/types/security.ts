import type { SecretValue } from '@/lib/shared/secretRef';

// Certificate Configuration
export interface ClientCert {
  format: 'pfx' | 'pem';
  pfx?: string; // base64-encoded .p12/.pfx content
  cert?: string; // PEM certificate string
  key?: string; // PEM private key string (encrypted at rest)
  // SecretValue per ADR-0007: plain string (legacy/inline) or a keychain
  // handle resolved in the Electron main process at wire-signing time.
  passphrase?: SecretValue;
}

export interface CaCert {
  pem: string; // PEM-encoded CA certificate chain
}

// Per-domain certificate entries (Postman / Insomnia parity). Each is scoped
// to a host pattern (`api.example.com`, `*.example.com`, `.example.com`) with
// an optional port. Selection is most-specific-wins; see
// `src/lib/shared/certMatcher.ts`. Desktop-only (mTLS / custom CA need
// Node TLS — the web build never applies these).
export interface HostClientCert {
  /** Stable id for list editing. */
  id: string;
  /** Host pattern. Exact, `*.sub` wildcard, or `.suffix`. */
  host: string;
  /** Optional port qualifier. Unset = any port. */
  port?: number;
  /** The mTLS client certificate material applied for matching requests. */
  cert: ClientCert;
}

export interface HostCaCert {
  id: string;
  host: string;
  port?: number;
  /** PEM-encoded CA certificate chain trusted for matching requests. */
  pem: string;
}

// Proxy Configuration
export type ProxyType = 'none' | 'http' | 'https' | 'socks4' | 'socks5';

export interface ProxyConfig {
  enabled: boolean;
  type: ProxyType;
  host: string;
  port: number;
  auth?: {
    username: string;
    // SecretValue per ADR-0007: plain string (legacy/inline) or a keychain
    // handle resolved in the Electron main process at wire-signing time.
    password: SecretValue;
  };
  bypassList?: string[]; // List of hosts to bypass proxy
}

/**
 * Minimum TLS protocol floor (single value, not a multi-select).
 * Maps directly to Node's `tls.connect` `minVersion` option. Disabling
 * non-contiguous protocol versions (e.g. allow 1.0 + 1.2 but block 1.1) is
 * not expressible cleanly via Node's API — a single floor covers ~95% of
 * real-world need (enforce a minimum). Desktop-only (Electron).
 */
export type MinTlsVersion = 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
