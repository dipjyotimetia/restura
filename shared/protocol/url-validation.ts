const PRIVATE_IPV4_RANGES: Array<RegExp> = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
  /^0\./,
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

function stripV4MappedPrefix(addr: string): string {
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

export function isPrivateAddress(hostname: string): boolean {
  const normalized = stripV4MappedPrefix(hostname);

  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1') {
    return true;
  }

  for (const re of PRIVATE_IPV4_RANGES) {
    if (re.test(normalized)) return true;
  }

  const lower = normalized.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')) {
    return true;
  }

  return false;
}

export function validateURL(urlString: string, options: URLValidationOptions = {}): URLValidationResult {
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

  const hostname = url.hostname.toLowerCase();

  if (!allowLocalhost && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1')) {
    return { valid: false, error: 'Localhost URLs are not allowed' };
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

  return { valid: true, warnings: warnings.length > 0 ? warnings : undefined };
}

export interface ResolvedAddressOptions {
  allowLocalhost?: boolean;
}

export function assertResolvedAddressAllowed(
  hostname: string,
  address: string,
  options: ResolvedAddressOptions = {}
): void {
  if (!isPrivateAddress(address)) return;

  const lower = hostname.toLowerCase();
  const isAllowedLocalhost =
    options.allowLocalhost &&
    (lower === 'localhost' || lower.endsWith('.localhost'));

  if (isAllowedLocalhost) return;

  throw new Error(
    `DNS resolution for ${hostname} returned private address ${address}; refusing to connect`
  );
}
