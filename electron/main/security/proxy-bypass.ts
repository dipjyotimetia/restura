function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Match the user-facing proxy bypass syntax without treating literals as regex. */
export function isProxyBypassed(hostname: string, bypassList: readonly string[]): boolean {
  const normalizedHostname = hostname.toLowerCase();

  return bypassList.some((rawPattern) => {
    const pattern = rawPattern.trim().toLowerCase();
    if (!pattern) return false;

    if (pattern.startsWith('*')) {
      const suffix = pattern.slice(1);
      return (
        normalizedHostname.endsWith(suffix) ||
        normalizedHostname === suffix.slice(1)
      );
    }

    if (pattern.includes('*')) {
      const expression = `^${pattern.split('*').map(escapeRegExp).join('.*')}$`;
      return new RegExp(expression).test(normalizedHostname);
    }

    return normalizedHostname === pattern;
  });
}
