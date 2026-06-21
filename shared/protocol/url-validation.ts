const PRIVATE_IPV4_RANGES: Array<RegExp> = [
  /^127\./, // 127.0.0.0/8 loopback
  /^10\./, // 10.0.0.0/8 RFC1918
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12 RFC1918
  /^192\.168\./, // 192.168.0.0/16 RFC1918
  /^169\.254\./, // 169.254.0.0/16 link-local
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // 100.64.0.0/10 CGNAT
  /^0\./, // 0.0.0.0/8 this-network
];

const BLOCKED_HOSTNAMES = [
  'localhost',
  'local',
  'internal',
  'metadata',
  'metadata.google.internal',
  '169.254.169.254',
  'instance-data',
  'kubernetes',
  'kubernetes.default',
  'kubernetes.default.svc',
];

const ALLOWED_SCHEMES = ['http:', 'https:'];

export interface URLValidationResult {
  valid: boolean;
  error?: string;
  warnings?: string[];
}

export interface URLValidationOptions {
  allowPrivateIPs?: boolean;
  allowLocalhost?: boolean;
  allowedSchemes?: string[];
  blockedHostnames?: string[];
  maxUrlLength?: number;
}

function stripBrackets(addr: string): string {
  return addr.replace(/^\[|\]$/g, '');
}

function stripV4MappedPrefix(addr: string): string {
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

function isPrivateIPv4(addr: string): boolean {
  for (const re of PRIVATE_IPV4_RANGES) {
    if (re.test(addr)) return true;
  }
  return false;
}

/**
 * Expand a (possibly compressed) IPv6 string into 8 hextet groups.
 * Returns null if the input is not a valid IPv6 address. Handles embedded
 * IPv4 forms (e.g. `::ffff:127.0.0.1`) by folding the dotted-quad into the
 * final two hextets.
 */
function expandIPv6(addr: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(addr)) return null;

  let s = addr;
  // Handle embedded IPv4 (e.g. ::ffff:127.0.0.1 → ::ffff:7f00:1)
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const prefix = dotted[1]!;
    const ipv4 = dotted[2]!;
    const parts = ipv4.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = (((parts[0]! << 8) | parts[1]!) >>> 0).toString(16);
    const lo = (((parts[2]! << 8) | parts[3]!) >>> 0).toString(16);
    s = `${prefix}${hi}:${lo}`;
  }

  const sides = s.split('::');
  if (sides.length > 2) return null;

  const leftStr = sides[0] ?? '';
  const rightStr = sides[1];
  const left = leftStr === '' ? [] : leftStr.split(':');
  const right = rightStr === undefined || rightStr === '' ? [] : rightStr.split(':');

  // No "::" abbreviation: must already be 8 groups.
  if (sides.length === 1) {
    if (left.length !== 8) return null;
  } else {
    if (left.length + right.length > 7) return null;
  }

  const fillCount = sides.length === 2 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(fillCount).fill('0'), ...right];
  if (groups.length !== 8) return null;

  const nums: number[] = [];
  for (const g of groups) {
    if (g.length === 0 || g.length > 4 || !/^[0-9a-fA-F]+$/.test(g)) return null;
    const n = parseInt(g, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    nums.push(n);
  }
  return nums;
}

function isPrivateIPv6Groups(groups: number[]): boolean {
  // :: (unspecified)
  if (groups.every((g) => g === 0)) return true;
  // ::1 (loopback)
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;

  const g0 = groups[0]!;
  const g1 = groups[1]!;
  const g2 = groups[2]!;
  const g3 = groups[3]!;
  const g4 = groups[4]!;
  const g5 = groups[5]!;
  const g6 = groups[6]!;
  const g7 = groups[7]!;

  // IPv4-mapped ::ffff:x.x.x.x — extract the embedded v4 and re-check.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const v4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    return isPrivateIPv4(v4);
  }
  // 6to4 2002::/16 wraps a v4 in the top 32 bits after the 2002 prefix.
  if (g0 === 0x2002) {
    const v4 = `${(g1 >> 8) & 0xff}.${g1 & 0xff}.${(g2 >> 8) & 0xff}.${g2 & 0xff}`;
    return isPrivateIPv4(v4);
  }
  // NAT64 well-known prefix 64:ff9b::/96 wraps v4 in the last 32 bits.
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    const v4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    return isPrivateIPv4(v4);
  }
  // ULA fc00::/7
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // Link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // Deprecated site-local fec0::/10
  if ((g0 & 0xffc0) === 0xfec0) return true;

  return false;
}

export function isPrivateAddress(hostname: string): boolean {
  const stripped = stripBrackets(hostname);
  const v4Normalized = stripV4MappedPrefix(stripped);

  if (v4Normalized === 'localhost' || v4Normalized === '127.0.0.1') {
    return true;
  }

  if (isPrivateIPv4(v4Normalized)) return true;

  if (stripped.includes(':')) {
    const groups = expandIPv6(stripped);
    if (groups) return isPrivateIPv6Groups(groups);
  }

  return false;
}

/** Extract an embedded IPv4 (v4-mapped / 6to4 / NAT64) from IPv6 groups, else null. */
function embeddedV4FromGroups(groups: number[]): string | null {
  const g0 = groups[0]!;
  const g1 = groups[1]!;
  const g2 = groups[2]!;
  const g3 = groups[3]!;
  const g4 = groups[4]!;
  const g5 = groups[5]!;
  const g6 = groups[6]!;
  const g7 = groups[7]!;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
  }
  if (g0 === 0x2002) {
    return `${(g1 >> 8) & 0xff}.${g1 & 0xff}.${(g2 >> 8) & 0xff}.${g2 & 0xff}`;
  }
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
  }
  return null;
}

const CLOUD_METADATA_IPV4 = '169.254.169.254';
const CLOUD_METADATA_HOSTNAMES = ['metadata.google.internal', 'metadata', 'instance-data'];

/**
 * Cloud-instance metadata endpoints: the link-local metadata IP
 * `169.254.169.254` (including IPv4-mapped-IPv6 and trailing-dot forms) and the
 * well-known metadata hostnames. Blocked UNCONDITIONALLY — even where private
 * IPs are otherwise permitted (Kafka/MQTT broker guards, the pinned
 * ws/socket.io/mcp transports that don't run `validateURL`) — because reaching
 * the metadata service is the canonical SSRF objective.
 */
export function isCloudMetadataHost(hostname: string): boolean {
  const h = stripBrackets(hostname).toLowerCase().replace(/\.+$/, '');
  if (stripV4MappedPrefix(h) === CLOUD_METADATA_IPV4) return true;
  if (h.includes(':')) {
    const groups = expandIPv6(h);
    if (groups && embeddedV4FromGroups(groups) === CLOUD_METADATA_IPV4) return true;
  }
  return CLOUD_METADATA_HOSTNAMES.some((n) => h === n || h.endsWith('.' + n));
}

export function validateURL(
  urlString: string,
  options: URLValidationOptions = {}
): URLValidationResult {
  const {
    allowPrivateIPs = false,
    allowLocalhost = false,
    allowedSchemes = ALLOWED_SCHEMES,
    blockedHostnames = BLOCKED_HOSTNAMES,
    maxUrlLength = 2048,
  } = options;

  const warnings: string[] = [];

  if (urlString.length > maxUrlLength) {
    return { valid: false, error: `URL exceeds maximum length of ${maxUrlLength} characters` };
  }

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  if (!allowedSchemes.includes(url.protocol)) {
    return { valid: false, error: `Invalid URL scheme. Allowed: ${allowedSchemes.join(', ')}` };
  }

  // Strip a trailing FQDN-root dot before policy comparison — `metadata.x.`
  // resolves identically to `metadata.x` but would slip past the exact-string
  // blocklist below.
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');

  if (
    !allowLocalhost &&
    (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1')
  ) {
    return { valid: false, error: 'Localhost URLs are not allowed' };
  }

  // Cloud-metadata endpoints are refused unconditionally — even when private
  // IPs are otherwise allowed (broker/registry guards pass allowPrivateIPs:true)
  // and even via IPv4-mapped-IPv6 / trailing-dot forms that evade the blocklist.
  if (isCloudMetadataHost(hostname)) {
    return { valid: false, error: `Cloud metadata endpoint is blocked: ${hostname}` };
  }

  for (const blocked of blockedHostnames) {
    const b = blocked.toLowerCase();
    if (allowLocalhost && (b === 'localhost' || b === '127.0.0.1')) continue;
    if (hostname === b || hostname.endsWith('.' + b)) {
      return { valid: false, error: `Hostname "${hostname}" is blocked for security reasons` };
    }
  }

  if (!allowPrivateIPs) {
    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (!(allowLocalhost && isLoopback) && isPrivateAddress(hostname)) {
      return { valid: false, error: `Private/internal IP addresses are not allowed: ${hostname}` };
    }
  }

  if (url.username || url.password) {
    warnings.push('URL contains credentials which may be logged or exposed');
  }

  if (url.pathname.includes('data:') || url.pathname.includes('javascript:')) {
    return { valid: false, error: 'URL path contains potentially malicious content' };
  }

  return { valid: true, ...(warnings.length > 0 ? { warnings } : {}) };
}

export interface ResolvedAddressOptions {
  allowLocalhost?: boolean;
  /**
   * If true, when the hostname is itself a literal IP address, allow private resolutions.
   * Used by Electron to permit the user-configured proxies and lab targets at
   * literal RFC1918 / link-local / loopback addresses they typed explicitly.
   */
  allowPrivateLiteralHost?: boolean;
}

export function assertResolvedAddressAllowed(
  hostname: string,
  address: string,
  options: ResolvedAddressOptions = {}
): void {
  if (!isPrivateAddress(address)) return;

  const lower = hostname.toLowerCase();
  const isAllowedLocalhost =
    options.allowLocalhost && (lower === 'localhost' || lower.endsWith('.localhost'));

  if (isAllowedLocalhost) return;
  if (options.allowPrivateLiteralHost) return;

  throw new Error(
    `DNS resolution for ${hostname} returned private address ${address}; refusing to connect`
  );
}
