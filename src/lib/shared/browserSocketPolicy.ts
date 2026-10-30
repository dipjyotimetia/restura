/**
 * Private-network policy for browser-direct sockets (#898, SEC-W1).
 *
 * On the web build, WebSocket, Socket.IO and GraphQL subscriptions connect
 * straight from the browser — the Worker's SSRF guard never sees them. This
 * in-app check is therefore the only gate, so it is stricter than the HTTP
 * pre-check: loopback and private/LAN targets are refused unless the app is a
 * Vite dev build or the user turned on "Allow private / internal IPs".
 * Cloud-metadata hosts are refused unconditionally (shared `validateURL`).
 *
 * Desktop never takes this path: it tunnels over IPC and the main process
 * applies the DNS-pinned guard.
 */
import { CREDENTIAL_HEADER_NAMES } from '@shared/protocol/credential-header-names';
import { validateURL } from '@shared/protocol/url-validation';
import { useSettingsStore } from '@/store/useSettingsStore';

/** Schemes a browser socket client may be pointed at (Socket.IO / graphql-sse use http). */
const SOCKET_SCHEMES = ['ws:', 'wss:', 'http:', 'https:'];

export interface BrowserSocketPolicyOptions {
  /** User opt-in ("Allow private / internal IPs"); also covers loopback here. */
  allowPrivateNetwork: boolean;
  /** Defaults to `import.meta.env.DEV` — local development against local servers. */
  devBuild?: boolean;
}

export type BrowserSocketTargetCheck = { ok: true } | { ok: false; error: string };

function isDevBuild(): boolean {
  try {
    return import.meta.env?.DEV === true;
  } catch {
    return false;
  }
}

export function checkBrowserSocketTarget(
  url: string,
  options: BrowserSocketPolicyOptions
): BrowserSocketTargetCheck {
  const relaxed = options.allowPrivateNetwork || (options.devBuild ?? isDevBuild());
  const result = validateURL(url, {
    allowedSchemes: SOCKET_SCHEMES,
    allowLocalhost: relaxed,
    allowPrivateIPs: relaxed,
  });
  if (result.valid) return { ok: true };
  const reason = result.error ?? 'Target refused';
  return {
    ok: false,
    error: relaxed
      ? reason
      : `${reason}. In the browser this connection is made directly, so loopback and private-network targets are refused — enable "Allow private / internal IPs" in Settings → Security or use the desktop app.`,
  };
}

/** `checkBrowserSocketTarget` with the user's current Security settings. */
export function checkBrowserSocketTargetFromSettings(url: string): BrowserSocketTargetCheck {
  const { allowPrivateIPs } = useSettingsStore.getState().settings;
  return checkBrowserSocketTarget(url, { allowPrivateNetwork: allowPrivateIPs === true });
}

/** True when `url` would travel unencrypted (ws:// or http://). */
export function isCleartextSocketUrl(url: string): boolean {
  return /^(ws|http):\/\//i.test(url.trim());
}

const CREDENTIAL_NAME_PATTERN = /auth|token|secret|password|passwd|api[-_]?key|session|cookie/i;

/** True when a header / param name conventionally carries a credential. */
export function isCredentialName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return CREDENTIAL_HEADER_NAMES.includes(lower) || CREDENTIAL_NAME_PATTERN.test(lower);
}

function urlCarriesCredentials(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return true;
    return [...parsed.searchParams].some(([key, value]) => value !== '' && isCredentialName(key));
  } catch {
    return false;
  }
}

/**
 * True when a connection would send credentials: userinfo or a credential-named
 * query param in the URL, a credential-named header / param with a value, or
 * any value in an auth payload (Socket.IO `auth`), which exists only to carry
 * credentials.
 */
export interface CredentialSources {
  url?: string | undefined;
  headers?: Record<string, string> | undefined;
  authPayload?: Record<string, unknown> | undefined;
}

export function carriesCredentials(input: CredentialSources): boolean {
  if (input.url !== undefined && urlCarriesCredentials(input.url)) return true;
  const named = Object.entries(input.headers ?? {}).some(
    ([key, value]) => value !== '' && isCredentialName(key)
  );
  const payload = Object.values(input.authPayload ?? {}).some(
    (v) => v !== undefined && v !== null && v !== ''
  );
  return named || payload;
}

export const CLEARTEXT_CREDENTIALS_CONFIRM = {
  title: 'Send credentials over an unencrypted connection?',
  description:
    'This connection uses ws:// or http://, so the credentials configured for it (auth headers, tokens, auth payload) travel in cleartext and can be read by anyone on the network path. Use wss:// or https:// unless you trust this network.',
  confirmText: 'Send anyway',
  variant: 'destructive' as const,
};
