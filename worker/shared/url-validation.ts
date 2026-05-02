const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
  /^fd[0-9a-f]{2}:/i,
  /^localhost$/i,
  /^0\.0\.0\.0$/,
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

  if (!allowLocalhost) {
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return { valid: false, error: 'Localhost URLs are not allowed' };
    }
  }

  for (const blocked of blockedHostnames) {
    if (allowLocalhost && (blocked.toLowerCase() === 'localhost' || blocked === '127.0.0.1')) {
      continue;
    }
    if (hostname === blocked.toLowerCase() || hostname.endsWith('.' + blocked.toLowerCase())) {
      return { valid: false, error: `Hostname "${hostname}" is blocked for security reasons` };
    }
  }

  if (!allowPrivateIPs) {
    for (const pattern of PRIVATE_IP_RANGES) {
      if (allowLocalhost && (
        pattern.source === '^localhost$' ||
        pattern.source === '^127\\.' ||
        pattern.source === '^::1$'
      )) {
        continue;
      }
      if (pattern.test(hostname)) {
        return { valid: false, error: `Private/internal IP addresses are not allowed: ${hostname}` };
      }
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

export function isPrivateAddress(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }
  const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = hostname.match(ipv4Pattern);
  if (match) {
    const [, a, b] = match.map(Number);
    if (a === 10) return true;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }
  if (hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80')) {
    return true;
  }
  return false;
}
