import { hasVariableToken } from '@/lib/shared/variableTokens';

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;
// The authority (userinfo@host:port) of a URL with its scheme already present.
const AUTHORITY_RE = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i;

/**
 * Why the URL bar's text can't be sent, as a specific, fixable message — or
 * `null` when it looks fine. A missing scheme is fine (the send defaults to
 * https://), as is anything templated with `{{var}}` (resolved at send time)
 * and spaces in the path / query (percent-encoded on send). Not a security
 * check: the shared SSRF guard still validates the resolved URL on send.
 */
export function describeUrlProblem(input: string): string | null {
  const url = input.trim();
  if (!url || hasVariableToken(url)) return null;

  const scheme = SCHEME_RE.exec(url)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https') {
    return `Unsupported scheme "${scheme}:" — use http:// or https://`;
  }
  const candidate = scheme ? url : `https://${url}`;

  const authority = AUTHORITY_RE.exec(candidate)?.[1] ?? '';
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (!hostPort) return 'Missing host — add a domain or IP after the scheme';
  if (/\s/.test(hostPort)) return 'The host contains spaces — remove them';

  // Port after the host (an IPv6 literal keeps its colons inside brackets).
  const portMatch = /^(?:\[[^\]]*\]|[^:]*):(.*)$/.exec(hostPort);
  if (portMatch) {
    const port = portMatch[1] ?? '';
    const n = Number(port);
    if (port && (!/^\d+$/.test(port) || n < 1 || n > 65535)) {
      return `Invalid port "${port}" — use a number from 1 to 65535`;
    }
  }

  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname) return 'Missing host — add a domain or IP after the scheme';
  } catch {
    return 'Invalid URL — check the host for unsupported characters';
  }
  return null;
}
