import {
  countUrlStringSecrets,
  redactUrlCredentialsForStorage,
} from '../collections/postman/text-redaction';
import type { AuthConfig, CollectionRequest } from '../types';
import { SECRET_FIELDS_BY_AUTH_BLOCK } from './auth-fields';
import { BROKER_PRESET_SLOTS } from './broker-preset-redaction';
import {
  countSecretKeyValues,
  redactSecretKeyValues,
  type SecretableRow,
} from './key-value-redaction';
import { isSecretHandle, redactSecret, type SecretValue, unwrapSecret } from './secret-ref';
import { blankSecretSlots, countSecretSlots, type SecretSlot } from './secret-slot';
import { countStdioEnvInlineSecrets, redactStdioEnvRows, stdioEnvOf } from './stdio-env-redaction';
import { STREAM_PRESET_SLOTS } from './stream-preset-redaction';

/**
 * Every place a saved request can hold a Secret. A new Protocol shape or
 * secret-bearing field is one entry in {@link REQUEST_SECRET_SLOTS}: the export
 * blanking and the export warning both read this list, so neither can miss it.
 *
 * Fields of untyped requests are read loosely on purpose: saved collections can
 * hold shapes the types do not describe, and the slots below decide what each
 * action does with them.
 */

type LooseRequest = Record<string, unknown>;

const loose = (request: CollectionRequest) => request as unknown as LooseRequest;
const typed = (request: LooseRequest) => request as unknown as CollectionRequest;

/** True for a non-empty plaintext secret (inline or bare string); handles never count. */
function isInlineWithValue(value: SecretValue | undefined): boolean {
  return !isSecretHandle(value) && unwrapSecret(value) !== '';
}

/** OAuth endpoints: not secrets, but a URL field can still carry a credential. */
const OAUTH2_URL_FIELDS = [
  'authorizationUrl',
  'tokenUrl',
  'deviceAuthorizationUrl',
  'redirectUri',
  'issuer',
] as const;

function oauth2UrlValues(auth: AuthConfig): Array<[string, string]> {
  const block = auth.oauth2 as Record<string, unknown> | undefined;
  if (!block || typeof block !== 'object') return [];
  return OAUTH2_URL_FIELDS.flatMap((field) => {
    const value = block[field];
    return typeof value === 'string' ? [[field, value] as [string, string]] : [];
  });
}

/** Returns a copy of `auth` with every known secret-bearing field redacted. */
export function redactAuthConfigSecrets(auth: AuthConfig): AuthConfig {
  const next: AuthConfig = { ...auth };
  for (const [block, fields] of Object.entries(SECRET_FIELDS_BY_AUTH_BLOCK)) {
    const current = next[block as keyof AuthConfig];
    if (!current || typeof current !== 'object') continue;
    const copy = { ...current } as Record<string, unknown>;
    for (const field of fields) {
      if (field in copy) {
        copy[field] = redactSecret(copy[field] as SecretValue | undefined);
      }
    }
    (next as unknown as Record<string, unknown>)[block] = copy;
  }
  const urls = oauth2UrlValues(next);
  if (urls.length > 0) {
    (next as unknown as Record<string, unknown>).oauth2 = {
      ...next.oauth2,
      ...Object.fromEntries(urls.map(([k, v]) => [k, redactUrlCredentialsForStorage(v)])),
    };
  }
  return next;
}

export function countAuthInlineSecrets(auth: AuthConfig | undefined): number {
  if (!auth) return 0;
  let count = 0;
  for (const [block, fields] of Object.entries(SECRET_FIELDS_BY_AUTH_BLOCK)) {
    const current = auth[block as keyof AuthConfig] as Record<string, unknown> | undefined;
    if (!current || typeof current !== 'object') continue;
    for (const field of fields) {
      if (isInlineWithValue(current[field] as SecretValue | undefined)) count++;
    }
  }
  for (const [, url] of oauth2UrlValues(auth)) count += countUrlStringSecrets(url);
  return count;
}

/**
 * A key/value row list on the request (a token typed into a header is just as
 * exfiltrable as one in `auth`).
 *
 * `count` has no array guard, unlike `blank`: a truthy non-array list passes
 * through `blank` with its values intact, so `count` throwing fails the export
 * closed where returning 0 would suppress the warning.
 */
function rowListSlot(field: 'headers' | 'params' | 'metadata'): SecretSlot {
  return {
    name: field,
    blank(request) {
      const rows = loose(request)[field];
      if (!Array.isArray(rows)) return request;
      return typed({ ...loose(request), [field]: redactSecretKeyValues(rows as SecretableRow[]) });
    },
    count: (request) => countSecretKeyValues(loose(request)[field] as SecretableRow[] | undefined),
  };
}

/**
 * Structured urlencoded / form-data body rows (Q29): the text rows of the
 * body that is actually sent, under the same credential-name rule as headers
 * and query params (and as `_postman` sidecar bodies). File rows hold file
 * bytes / names, never typed credentials, and are left alone; rows left over
 * on a non-form body are not exported, so they are neither counted nor touched.
 */
const FORM_BODY_TYPES = new Set(['form-data', 'x-www-form-urlencoded']);

type FormRow = SecretableRow & { type?: unknown };

function formBodyRows(request: CollectionRequest): FormRow[] | undefined {
  const body = loose(request).body as { type?: unknown; formData?: unknown } | undefined;
  if (!body || !FORM_BODY_TYPES.has(String(body.type)) || !Array.isArray(body.formData)) {
    return undefined;
  }
  return body.formData as FormRow[];
}

const FORM_BODY_SLOT: SecretSlot = {
  name: 'formBody',
  blank(request) {
    const rows = formBodyRows(request);
    if (!rows) return request;
    return typed({
      ...loose(request),
      body: {
        ...(loose(request).body as object),
        formData: rows.map((row) =>
          row.type === 'file' ? row : (redactSecretKeyValues([row])?.[0] ?? row)
        ),
      },
    });
  },
  count: (request) =>
    countSecretKeyValues(formBodyRows(request)?.filter((row) => row.type !== 'file')),
};

/**
 * URL userinfo and credential-named query values, for every request kind with a
 * `url`. `count` throws on a non-string URL, as `rowListSlot` does on a non-array
 * list: `blank` passes it through, so returning 0 would suppress the warning.
 */
const URL_SLOT: SecretSlot = {
  name: 'url',
  blank(request) {
    const url = loose(request).url;
    if (typeof url !== 'string') return request;
    return typed({ ...loose(request), url: redactUrlCredentialsForStorage(url) });
  },
  count(request) {
    const url = loose(request).url;
    return url === undefined || url === null ? 0 : countUrlStringSecrets(url as string);
  },
};

const AUTH_SLOT: SecretSlot = {
  name: 'auth',
  blank: (request) =>
    'auth' in request
      ? typed({ ...loose(request), auth: redactAuthConfigSecrets(request.auth as AuthConfig) })
      : request,
  count: (request) =>
    'auth' in request ? countAuthInlineSecrets(request.auth as AuthConfig | undefined) : 0,
};

/** MCP stdio launch env (credential-named values, inline SecretRefs). */
const STDIO_ENV_SLOT: SecretSlot = {
  name: 'stdioEnv',
  blank(request) {
    const env = stdioEnvOf(loose(request));
    if (!env) return request;
    return typed({
      ...loose(request),
      stdio: { ...(loose(request).stdio as object), env: redactStdioEnvRows(env) },
    });
  },
  count: (request) => countStdioEnvInlineSecrets(stdioEnvOf(loose(request))),
};

export const REQUEST_SECRET_SLOTS: readonly SecretSlot[] = [
  URL_SLOT,
  rowListSlot('headers'),
  rowListSlot('params'),
  rowListSlot('metadata'),
  FORM_BODY_SLOT,
  AUTH_SLOT,
  STDIO_ENV_SLOT,
  ...BROKER_PRESET_SLOTS,
  ...STREAM_PRESET_SLOTS,
];

/** Copy of a saved request with every slot blanked. Always a new object. */
export function blankRequestSecrets<T extends CollectionRequest>(request: T): T {
  return blankSecretSlots(REQUEST_SECRET_SLOTS, { ...request });
}

/** Plaintext secrets {@link blankRequestSecrets} would remove. */
export function countRequestSecrets(request: CollectionRequest): number {
  return countSecretSlots(REQUEST_SECRET_SLOTS, request);
}
