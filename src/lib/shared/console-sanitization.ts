import { isUrlHeaderName, scanUrlCredentials } from '@shared/collections/postman/text-redaction';
import { CREDENTIAL_HEADER_NAMES } from '@shared/protocol/credential-header-names';
import { bodyTokenPatterns, headerDenylistRegex } from '@shared/protocol/secret-patterns';
import { isSecretFieldName } from '@shared/secrets/key-value-redaction';
import type { ConsoleEntry, ConsoleFrame, ConsoleNativeDraft } from '@/store/useConsoleStore';

export const CONSOLE_REDACTED = '[REDACTED]';

const credentialHeaders = new Set(CREDENTIAL_HEADER_NAMES);
const headerPatterns = headerDenylistRegex();

export function isConsoleCredentialHeader(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized === 'cookie' ||
    normalized === 'set-cookie' ||
    credentialHeaders.has(normalized) ||
    isSecretFieldName(name) ||
    headerPatterns.some((pattern) => pattern.test(name))
  );
}

function isCredentialQueryParam(name: string): boolean {
  return (
    isSecretFieldName(name) ||
    /^(?:access|refresh|id)?[-_]?token$/i.test(name) ||
    /^(?:client[-_]?)?secret$/i.test(name) ||
    /^(?:password|passwd|pwd|sig|signature|code|auth|session|sessionid|sid)$/i.test(name) ||
    /^x-(?:amz-(?:signature|security-token|credential)|goog-signature)$/i.test(name)
  );
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      isSecretFieldName(key) ? CONSOLE_REDACTED : redactJson(child),
    ])
  );
}

/** Redact recognisable credentials from diagnostic text without changing safe text. */
export function sanitizeConsoleText(value: string): string {
  let text = value;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      // Preserve pretty-printed protocol frames so redaction does not turn
      // readable structured evidence into a different representation.
      const indent = /\n([\t ]+)"/.exec(text)?.[1];
      text = JSON.stringify(redactJson(JSON.parse(text)), null, indent);
    } catch {
      // Keep arbitrary diagnostic text readable; token patterns below still apply.
    }
  }
  for (const pattern of bodyTokenPatterns()) text = text.replace(pattern, CONSOLE_REDACTED);
  // Cookies frequently reach connection/frame diagnostics as plain key=value text.
  return text.replace(
    /\b(?:session(?:id)?|sid|csrf|xsrf|auth(?:entication)?|access_token|refresh_token)=[^\s;,&"']+/gi,
    (match) => `${match.split('=', 1)[0]}=${CONSOLE_REDACTED}`
  );
}

const ENCODED_REDACTED = encodeURIComponent(CONSOLE_REDACTED);

/** An absolute URL with a host. `user:pw@host` parses as scheme `user:` with neither. */
function isHostUrl(value: string): boolean {
  try {
    return new URL(value).host !== '';
  } catch {
    return false;
  }
}

export function sanitizeConsoleUrl(value: string): string {
  if (isHostUrl(value)) {
    return scanUrlCredentials(value, {
      mask: ENCODED_REDACTED,
      userinfoMask: `${ENCODED_REDACTED}:${ENCODED_REDACTED}`,
      isSecretParam: isCredentialQueryParam,
    }).redacted;
  }
  const { redacted } = scanUrlCredentials(value, {
    mask: CONSOLE_REDACTED,
    isSecretParam: isCredentialQueryParam,
  });
  return sanitizeConsoleText(redacted);
}

/** RFC 6265 attributes safe to keep visible; anything else is dropped. */
const SET_COOKIE_ATTRIBUTES = new Set([
  'domain',
  'path',
  'expires',
  'max-age',
  'httponly',
  'secure',
  'samesite',
  'partitioned',
  'priority',
]);

/**
 * `name=value; attrs` → `name=[REDACTED]; <known attrs>` so the console Cookies
 * view still lists each cookie. A field without a `name=` pair, and any
 * unknown attribute (could carry anything), is redacted / dropped wholesale.
 */
export function redactSetCookie(raw: string): string {
  const [pair = '', ...attrs] = raw.split(';').map((s) => s.trim());
  const eq = pair.indexOf('=');
  const name = eq < 0 ? '' : pair.slice(0, eq).trim();
  if (!name) return CONSOLE_REDACTED;
  const kept = attrs.filter((attr) => {
    const i = attr.indexOf('=');
    return SET_COOKIE_ATTRIBUTES.has((i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase());
  });
  return [
    `${sanitizeConsoleText(name)}=${CONSOLE_REDACTED}`,
    ...kept.map(sanitizeConsoleText),
  ].join('; ');
}

function sanitizeHeaderValue(name: string, value: string | string[]): string | string[] {
  const sanitize = isUrlHeaderName(name) ? sanitizeConsoleUrl : sanitizeConsoleText;
  return Array.isArray(value) ? value.map(sanitize) : sanitize(value);
}

export function sanitizeConsoleHeaders<T extends Record<string, string | string[]>>(headers: T): T {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      isConsoleCredentialHeader(key)
        ? Array.isArray(value)
          ? value.map(() => CONSOLE_REDACTED)
          : CONSOLE_REDACTED
        : sanitizeHeaderValue(key, value),
    ])
  ) as T;
}

function sanitizeDraft(draft: ConsoleNativeDraft | undefined): ConsoleNativeDraft | undefined {
  if (!draft) return undefined;
  switch (draft.kind) {
    case 'http':
      return {
        ...draft,
        url: sanitizeConsoleUrl(draft.url),
        headers: sanitizeConsoleHeaders(draft.headers),
        ...(draft.body !== undefined && { body: sanitizeConsoleText(draft.body) }),
      };
    case 'graphql':
      return {
        ...draft,
        url: sanitizeConsoleUrl(draft.url),
        headers: sanitizeConsoleHeaders(draft.headers),
        query: sanitizeConsoleText(draft.query),
        variables: sanitizeConsoleText(draft.variables),
        ...(draft.operationName !== undefined && {
          operationName: sanitizeConsoleText(draft.operationName),
        }),
      };
    case 'grpc':
      return {
        ...draft,
        url: sanitizeConsoleUrl(draft.url),
        service: sanitizeConsoleText(draft.service),
        method: sanitizeConsoleText(draft.method),
        message: sanitizeConsoleText(draft.message),
        metadata: sanitizeConsoleHeaders(draft.metadata),
      };
    case 'mcp':
      return {
        ...draft,
        url: sanitizeConsoleUrl(draft.url),
        headers: sanitizeConsoleHeaders(draft.headers),
        ...(draft.method !== undefined && { method: sanitizeConsoleText(draft.method) }),
        ...(draft.params !== undefined && { params: sanitizeConsoleText(draft.params) }),
      };
  }
}

/** The one-way console trust boundary. Call before any entry reaches state or persistence. */
export function sanitizeConsoleEntry(entry: Omit<ConsoleEntry, 'id'>): Omit<ConsoleEntry, 'id'> {
  const nativeDraft = sanitizeDraft(entry.nativeDraft);
  return {
    ...entry,
    request: {
      ...entry.request,
      url: sanitizeConsoleUrl(entry.request.url),
      headers: sanitizeConsoleHeaders(entry.request.headers),
      ...(entry.request.body !== undefined && { body: sanitizeConsoleText(entry.request.body) }),
    },
    ...(entry.resolvedUrl !== undefined && { resolvedUrl: sanitizeConsoleUrl(entry.resolvedUrl) }),
    response: {
      ...entry.response,
      statusText: sanitizeConsoleText(entry.response.statusText),
      headers: sanitizeConsoleHeaders(entry.response.headers),
      // Cookie values are credentials (the set-cookie header stays fully
      // redacted); names + known attributes survive so the Cookies view works.
      ...(entry.response.setCookies && {
        setCookies: entry.response.setCookies.map(redactSetCookie),
      }),
      body: sanitizeConsoleText(entry.response.body),
    },
    ...(entry.scriptLogs && {
      scriptLogs: entry.scriptLogs.map((log) => ({
        ...log,
        message: sanitizeConsoleText(log.message),
      })),
    }),
    ...(entry.tests && {
      tests: entry.tests.map((test) => ({
        ...test,
        name: sanitizeConsoleText(test.name),
        ...(test.error !== undefined && { error: sanitizeConsoleText(test.error) }),
      })),
    }),
    ...(nativeDraft !== undefined && { nativeDraft }),
  };
}

/** Frames never leave the console insertion boundary as raw payloads. */
export function sanitizeConsoleFrame(frame: Omit<ConsoleFrame, 'id'>): Omit<ConsoleFrame, 'id'> {
  return {
    ...frame,
    ...(frame.label !== undefined && { label: sanitizeConsoleText(frame.label) }),
    payload: sanitizeConsoleText(frame.payload),
  };
}
