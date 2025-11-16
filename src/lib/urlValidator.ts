/**
 * URL Validator and SSRF Protection
 * Prevents Server-Side Request Forgery attacks by validating URLs
 */

// Private IP ranges that should be blocked
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

// Blocked hostnames that could be used for SSRF
const BLOCKED_HOSTNAMES = [
  'localhost',
  'local',
  'internal',
  'metadata',
  'metadata.google.internal',
  '169.254.169.254', // AWS/GCP metadata
  'instance-data',
  'kubernetes',
  'kubernetes.default',
  'kubernetes.default.svc',
];

// Allowed URL schemes
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

/**
 * Validates a URL for security concerns (SSRF protection)
 */
export function validateURL(urlString: string, options: URLValidationOptions = {}): URLValidationResult {
  const {
    allowPrivateIPs = false,
    allowLocalhost = false,
    allowedSchemes = ALLOWED_SCHEMES,
    blockedHostnames = BLOCKED_HOSTNAMES,
    maxUrlLength = 2048,
  } = options;

  const warnings: string[] = [];

  // Check URL length
  if (urlString.length > maxUrlLength) {
    return {
      valid: false,
      error: `URL exceeds maximum length of ${maxUrlLength} characters`,
    };
  }

  // Try to parse the URL
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return {
      valid: false,
      error: 'Invalid URL format',
    };
  }

  // Check scheme
  if (!allowedSchemes.includes(url.protocol)) {
    return {
      valid: false,
      error: `Invalid URL scheme. Allowed: ${allowedSchemes.join(', ')}`,
    };
  }

  // Extract hostname
  const hostname = url.hostname.toLowerCase();

  // Check for localhost
  if (!allowLocalhost) {
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return {
        valid: false,
        error: 'Localhost URLs are not allowed',
      };
    }
  }

  // Check blocked hostnames
  for (const blocked of blockedHostnames) {
    // Skip localhost check if explicitly allowed
    if (allowLocalhost && (blocked.toLowerCase() === 'localhost' || blocked === '127.0.0.1')) {
      continue;
    }
    if (hostname === blocked.toLowerCase() || hostname.endsWith('.' + blocked.toLowerCase())) {
      return {
        valid: false,
        error: `Hostname "${hostname}" is blocked for security reasons`,
      };
    }
  }

  // Check for private IP addresses
  if (!allowPrivateIPs) {
    for (const pattern of PRIVATE_IP_RANGES) {
      // Skip localhost patterns if explicitly allowed
      if (allowLocalhost && (
        pattern.source === '^localhost$' ||
        pattern.source === '^127\\.' ||
        pattern.source === '^::1$'
      )) {
        continue;
      }
      if (pattern.test(hostname)) {
        return {
          valid: false,
          error: `Private/internal IP addresses are not allowed: ${hostname}`,
        };
      }
    }
  }

  // Check for URL with credentials (potential security risk)
  if (url.username || url.password) {
    warnings.push('URL contains credentials which may be logged or exposed');
  }

  // Check for suspicious port numbers
  const suspiciousPorts = [22, 23, 25, 110, 143, 445, 3306, 5432, 6379, 27017];
  if (url.port && suspiciousPorts.includes(parseInt(url.port, 10))) {
    warnings.push(`Port ${url.port} is commonly used for internal services`);
  }

  // Check for IP-based URLs (less secure than domain names)
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    warnings.push('Using IP address instead of domain name may be less secure');
  }

  // Check for data URLs or other unusual schemes in the path
  if (url.pathname.includes('data:') || url.pathname.includes('javascript:')) {
    return {
      valid: false,
      error: 'URL path contains potentially malicious content',
    };
  }

  return {
    valid: true,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Sanitizes a URL by removing potentially dangerous elements
 */
export function sanitizeURL(urlString: string): string {
  try {
    const url = new URL(urlString);

    // Remove credentials from URL
    url.username = '';
    url.password = '';

    // Remove hash (fragment) as it can contain script execution
    url.hash = '';

    return url.toString();
  } catch {
    return urlString;
  }
}

/**
 * Check if a hostname resolves to a private IP
 * Note: This is a client-side check and may not catch all cases
 */
export function isLikelyPrivateHost(hostname: string): boolean {
  const lowerHostname = hostname.toLowerCase();

  // Check common internal hostname patterns
  const internalPatterns = [
    /^.*\.local$/,
    /^.*\.internal$/,
    /^.*\.lan$/,
    /^.*\.corp$/,
    /^.*\.intranet$/,
    /^intranet\./,
    /^internal\./,
    /^private\./,
    /^dev\./,
    /^staging\./,
    /^test\./,
  ];

  for (const pattern of internalPatterns) {
    if (pattern.test(lowerHostname)) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts and validates URL from user input with environment variable substitution
 */
export function validateURLWithVariables(
  urlString: string,
  variables: Record<string, string>,
  options: URLValidationOptions = {}
): URLValidationResult {
  // First, resolve any environment variables
  let resolvedUrl = urlString;
  const variablePattern = /\{\{([^}]+)\}\}/g;
  let match;

  while ((match = variablePattern.exec(urlString)) !== null) {
    const varName = match[1]?.trim();
    const varValue = varName ? variables[varName] : undefined;

    if (varValue !== undefined) {
      resolvedUrl = resolvedUrl.replace(match[0], varValue);
    }
  }

  // Then validate the resolved URL
  return validateURL(resolvedUrl, options);
}

export default validateURL;
