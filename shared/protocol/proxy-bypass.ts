/**
 * The user-facing proxy bypass syntax, shared by the desktop app and the CLI:
 * exact host, `*.suffix` / `*suffix`, or a `*` glob — literals never act as a
 * regex. Matching is case-insensitive, and IPv6 brackets are stripped from both
 * the host (`URL.hostname` keeps them) and each entry, so `::1` and `[::1]`
 * both match `http://[::1]/`.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1');
}

export function isProxyBypassed(hostname: string, bypassList: readonly string[]): boolean {
  const host = normalize(hostname);
  return bypassList.some((raw) => {
    const pattern = normalize(raw);
    if (!pattern) return false;
    if (pattern.startsWith('*')) {
      const suffix = pattern.slice(1);
      return host.endsWith(suffix) || host === suffix.slice(1);
    }
    if (pattern.includes('*')) {
      return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`).test(host);
    }
    return host === pattern;
  });
}
