/**
 * `tls.connect` identity options for a URL hostname: `host` (IPv6 brackets
 * stripped) drives the certificate hostname check, and `servername` (SNI) is
 * set only for DNS names. RFC 6066 forbids IP SNI, and Node 26 throws
 * ERR_INVALID_ARG_VALUE on it (earlier majors only warned, DEP0123).
 *
 * Spread both when wrapping an existing `socket`: with neither set, Node checks
 * the certificate against the socket's dial host (a CONNECT/SOCKS proxy) or
 * 'localhost', not the target.
 *
 * Runtime-neutral (no `node:net`): for special schemes (https, wss) `URL.hostname`
 * normalises IPv4 to a dotted quad and keeps IPv6 bracketed, and a DNS name can
 * never contain `:`. Opaque hosts (grpcs://127.1) stay raw and are treated as
 * DNS names; Node accepts that SNI and checkServerIdentity rejects it (fail-closed).
 */
export function tlsIdentity(hostname: string): { host: string; servername?: string } {
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const isIpLiteral = host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  return isIpLiteral ? { host } : { host, servername: host };
}
