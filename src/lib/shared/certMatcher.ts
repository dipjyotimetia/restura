/**
 * Per-domain certificate selection (Postman / Insomnia parity). Given a
 * request URL and the user's lists of host-scoped client / CA certificates,
 * picks the single most-specific entry that applies.
 *
 * Matching rules (mirrors the proxy bypass-list style in `proxyHelper.ts`):
 *  - `host` matches the request hostname when it is an exact match, or a
 *    `*.example.com` wildcard (covers `sub.example.com` and the apex
 *    `example.com`), or a leading-dot suffix `.example.com`.
 *  - `port` is optional. When set it must equal the request port (the URL's
 *    explicit port, or the scheme default 443/80). When unset the entry
 *    matches any port on that host.
 *  - Specificity, highest first: exact host beats wildcard/suffix; among equal
 *    host specificity, an entry that pins a port beats one that does not; ties
 *    break on longer host pattern (more labels = more specific).
 *
 * These are desktop-only (mTLS / custom CA need Node TLS). The web build never
 * calls this — `buildDesktopTransportConfig` is dropped on the Worker path.
 */

export interface HostScopedEntry {
  /** Host pattern: `api.example.com`, `*.example.com`, or `.example.com`. */
  host: string;
  /** Optional port qualifier. Unset = any port. */
  port?: number;
}

interface Specificity {
  /** 2 = exact host, 1 = wildcard/suffix. */
  hostKind: number;
  /** 1 = port pinned, 0 = any port. */
  portPinned: number;
  /** Tie-breaker: length of the host pattern. */
  hostLength: number;
}

/** Normalise a host pattern to its bare suffix and whether it was a wildcard. */
function classifyHost(pattern: string): { suffix: string; wildcard: boolean } {
  const lower = pattern.trim().toLowerCase();
  if (lower.startsWith('*.')) return { suffix: lower.slice(2), wildcard: true };
  if (lower.startsWith('.')) return { suffix: lower.slice(1), wildcard: true };
  return { suffix: lower, wildcard: false };
}

function entryMatches(entry: HostScopedEntry, hostname: string, port: number): boolean {
  if (entry.port !== undefined && entry.port !== port) return false;
  const host = hostname.toLowerCase();
  const { suffix, wildcard } = classifyHost(entry.host);
  if (!suffix) return false;
  if (wildcard) return host === suffix || host.endsWith('.' + suffix);
  return host === suffix;
}

function specificityOf(entry: HostScopedEntry): Specificity {
  const { wildcard, suffix } = classifyHost(entry.host);
  return {
    hostKind: wildcard ? 1 : 2,
    portPinned: entry.port !== undefined ? 1 : 0,
    hostLength: suffix.length,
  };
}

function moreSpecific(a: Specificity, b: Specificity): boolean {
  if (a.hostKind !== b.hostKind) return a.hostKind > b.hostKind;
  if (a.portPinned !== b.portPinned) return a.portPinned > b.portPinned;
  return a.hostLength > b.hostLength;
}

/**
 * Select the most-specific entry from `entries` that matches `url`, or
 * `undefined` when none apply. `url` may be a string or a parsed URL; an
 * unparseable string yields `undefined`.
 */
export function selectCertForUrl<T extends HostScopedEntry>(
  url: string | URL,
  entries: readonly T[] | undefined
): T | undefined {
  if (!entries || entries.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return undefined;
  }
  const hostname = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;

  let best: T | undefined;
  let bestSpec: Specificity | undefined;
  for (const entry of entries) {
    if (!entryMatches(entry, hostname, port)) continue;
    const spec = specificityOf(entry);
    if (!bestSpec || moreSpecific(spec, bestSpec)) {
      best = entry;
      bestSpec = spec;
    }
  }
  return best;
}
