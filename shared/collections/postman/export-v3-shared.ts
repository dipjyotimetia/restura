import { isConfiguredAuth } from '../../auth/inheritance';
import { migrateScriptRsToPm } from '../../scripts/script-migrations';
import type { SecretValue } from '../../secrets/secret-ref';
import type { AuthConfig, KeyValue, ScopedVariable } from '../../types';
import { arr, isObj, type Raw, str } from './common';
import type { PostmanExportReportBuilder } from './export-report';
import type { PostmanSidecar } from './sidecar';

/**
 * Helpers shared by the Postman v3 serializer (`export-v3.ts`) and its
 * per-kind converters (`export-v3-items.ts`): auth (the inverse of
 * `auth.ts` + `parse-v3-shared.ts`), secret values, key-value rows, scripts
 * and variables. Output objects are built in a fixed key order so the dumped
 * YAML is deterministic.
 */

export interface ExportContext {
  report: PostmanExportReportBuilder;
  /** Applied to every script (defaults to the `rs.*` → `pm.*` migration). */
  transformScript: (script: string) => string;
}

export const defaultExportScript = migrateScriptRsToPm;

/** Drop `undefined` values (key order preserved). */
export function defined<T extends Raw>(obj: T): T {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

// ── secret values ───────────────────────────────────────────────────────────

/**
 * A SecretValue as file text. Plaintext only for inline values (the caller
 * already applied the export "include secrets" redaction); keychain handles
 * and external references are written EMPTY and reported — they never
 * resolve to plaintext in the renderer and a placeholder would be a broken
 * reference in Postman.
 */
export function secretText(
  value: SecretValue | undefined,
  owner: string,
  ctx: ExportContext
): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value.kind === 'inline') return value.value;
  ctx.report.emptied('secret-handle', owner);
  return '';
}

// ── rows ────────────────────────────────────────────────────────────────────

/** Restura rows → v3 `v3-key-value-meta` rows (secret rows emptied). */
export function kvRows(
  rows: readonly KeyValue[] | undefined,
  owner: string,
  ctx: ExportContext
): Raw[] {
  return (rows ?? []).map((r) => {
    const secretRef = (r as { secretRef?: SecretValue }).secretRef;
    let value = r.value;
    if (secretRef !== undefined) value = secretText(secretRef, owner, ctx);
    return defined({
      key: r.key,
      value,
      disabled: r.enabled === false ? true : undefined,
      description: r.description || undefined,
    });
  });
}

// ── variables ───────────────────────────────────────────────────────────────

/**
 * Restura variables → v3 `variables`. Secret variables are exported as plain
 * variables with an EMPTY value (a v3 `secret: true` variable needs a vault
 * `source` we cannot produce) and reported — unless the import sidecar still
 * holds the original vault `source`, which round-trips as-is (it never held a
 * value).
 */
export function exportVariables(
  variables: readonly ScopedVariable[] | undefined,
  sidecar: PostmanSidecar | undefined,
  owner: string,
  ctx: ExportContext
): Raw[] | undefined {
  if (!variables || variables.length === 0) return undefined;
  const sources = new Map<string, unknown>();
  for (const v of arr(sidecar?.variable)) {
    if (isObj(v) && v.secret === true && typeof v.key === 'string' && isObj(v.source)) {
      sources.set(v.key, v.source);
    }
  }
  return variables.map((v) => {
    const isSecret = v.secret === true || v.secretRef !== undefined;
    if (!isSecret) {
      return defined({
        key: v.key,
        value: v.value,
        disabled: v.enabled === false ? true : undefined,
        description: v.description || undefined,
      });
    }
    const source = sources.get(v.key);
    if (source !== undefined) {
      return defined({
        key: v.key,
        secret: true,
        disabled: v.enabled === false ? true : undefined,
        description: v.description || undefined,
        source,
      });
    }
    ctx.report.emptied('secret-variable', owner, v.key);
    return defined({
      key: v.key,
      value: '',
      disabled: v.enabled === false ? true : undefined,
      description: v.description || undefined,
    });
  });
}

// ── scripts ─────────────────────────────────────────────────────────────────

const SCRIPT_KEYS = ['type', 'code', 'language', 'packages', 'requests'] as const;

function cleanScript(s: unknown, allowed: ReadonlySet<string>): Raw | undefined {
  if (!isObj(s) || typeof s.code !== 'string' || !allowed.has(str(s.type))) return undefined;
  const out: Raw = {};
  for (const k of SCRIPT_KEYS) if (s[k] !== undefined) out[k] = s[k];
  return out;
}

export interface ScriptPhases {
  pre: string;
  test: string;
  /** Every phase this v3 object accepts (sidecar restore filter). */
  allowed: ReadonlySet<string>;
}

export const HTTP_REQUEST_PHASES: ScriptPhases = {
  pre: 'beforeRequest',
  test: 'afterResponse',
  allowed: new Set(['beforeRequest', 'afterResponse']),
};
export const GRAPHQL_PHASES: ScriptPhases = {
  pre: 'beforeQuery',
  test: 'afterResponse',
  allowed: new Set(['beforeQuery', 'afterResponse']),
};
export const GRPC_PHASES: ScriptPhases = {
  pre: 'beforeInvoke',
  test: 'afterResponse',
  allowed: new Set(['beforeInvoke', 'onIncomingMessage', 'afterResponse']),
};
export const KAFKA_PHASES = new Set([
  'beforeConsume',
  'onIncomingMessage',
  'afterConsume',
  'beforeProduce',
  'afterProduce',
]);
export const COLLECTION_PHASES: ScriptPhases = {
  pre: 'http:beforeRequest',
  test: 'http:afterResponse',
  allowed: new Set([
    'graphql:beforeQuery',
    'graphql:afterResponse',
    'grpc:beforeInvoke',
    'grpc:onIncomingMessage',
    'grpc:afterResponse',
    'http:beforeRequest',
    'http:afterResponse',
    'kafka:beforeConsume',
    'kafka:onIncomingMessage',
    'kafka:afterConsume',
    'kafka:beforeProduce',
    'kafka:afterProduce',
  ]),
};

/**
 * Restura pre-request / test scripts → v3 `scripts`. Scripts kept in the
 * sidecar at import are restored: same-kind ones that lost to the imported
 * one (`event`) go FIRST so the importer's "last one wins" picks the same
 * script again; protocol scripts with no Restura phase (`scripts`) follow.
 */
export function exportScripts(
  pre: string | undefined,
  test: string | undefined,
  sidecar: PostmanSidecar | undefined,
  phases: ScriptPhases,
  ctx: ExportContext
): Raw[] | undefined {
  const out: Raw[] = [];
  const shadowed = arr(sidecar?.event)
    .map((s) => cleanScript(s, phases.allowed))
    .filter((s): s is Raw => s !== undefined);
  for (const s of shadowed) if (s.type === phases.pre) out.push(s);
  if (pre) out.push({ type: phases.pre, code: ctx.transformScript(pre) });
  for (const s of shadowed) if (s.type === phases.test) out.push(s);
  if (test) out.push({ type: phases.test, code: ctx.transformScript(test) });
  for (const s of arr(sidecar?.scripts)) {
    const clean = cleanScript(s, phases.allowed);
    if (clean) out.push(clean);
  }
  return out.length > 0 ? out : undefined;
}

/** Sidecar scripts for a kind without Restura script slots (Kafka). */
export function restoreScripts(sidecar: PostmanSidecar | undefined, allowed: ReadonlySet<string>) {
  const out = arr(sidecar?.scripts)
    .map((s) => cleanScript(s, allowed))
    .filter((s): s is Raw => s !== undefined);
  return out.length > 0 ? out : undefined;
}

// ── auth ────────────────────────────────────────────────────────────────────

type Cred = { key: string; value: unknown };

const OAUTH2_GRANTS: Record<string, string> = {
  authorization_code: 'authorization_code',
  client_credentials: 'client_credentials',
  password: 'password_credentials',
};

function credsOf(pairs: Array<[string, string | undefined]>): Cred[] {
  return pairs
    .filter((p): p is [string, string] => p[1] !== undefined)
    .map(([key, value]) => ({ key, value }));
}

/**
 * Q28: the node's Postman auth was an explicit `noauth` (`_postman.noauth`,
 * set at import) and the user has not configured an auth since. It must be
 * exported as an explicit `noauth` — omitted means inherit, and Postman /
 * Newman would sign it with an ancestor's credential.
 */
export function isExplicitNoauth(
  auth: AuthConfig | undefined,
  sidecar: PostmanSidecar | undefined
): boolean {
  return sidecar?.noauth === true && !isConfiguredAuth(auth);
}

/**
 * Restura `AuthConfig` → v3 `{ type, credentials }` (the inverse of
 * `convertPostmanAuth`), without sidecar data. `undefined` = not exportable.
 */
function typedAuthToV3(auth: AuthConfig, owner: string, ctx: ExportContext): Raw | undefined {
  const s = (v: SecretValue | undefined) => secretText(v, owner, ctx);
  const opt = (v: string | undefined) => (v === undefined || v === '' ? undefined : v);
  switch (auth.type) {
    case 'none':
      return { type: 'noauth' };
    case 'basic':
      return {
        type: 'basic',
        credentials: credsOf([
          ['username', auth.basic?.username ?? ''],
          ['password', s(auth.basic?.password)],
        ]),
      };
    case 'bearer':
      return { type: 'bearer', credentials: credsOf([['token', s(auth.bearer?.token)]]) };
    case 'api-key':
      return {
        type: 'apikey',
        credentials: credsOf([
          ['key', auth.apiKey?.key ?? ''],
          ['value', s(auth.apiKey?.value)],
          ['in', auth.apiKey?.in === 'query' ? 'query' : 'header'],
        ]),
      };
    case 'digest':
      return {
        type: 'digest',
        credentials: credsOf([
          ['username', auth.digest?.username ?? ''],
          ['password', s(auth.digest?.password)],
        ]),
      };
    case 'aws-signature':
      return {
        type: 'awsv4',
        credentials: credsOf([
          ['accessKey', auth.awsSignature?.accessKey ?? ''],
          ['secretKey', s(auth.awsSignature?.secretKey)],
          ['region', auth.awsSignature?.region ?? ''],
          ['service', auth.awsSignature?.service ?? ''],
        ]),
      };
    case 'ntlm':
      return {
        type: 'ntlm',
        credentials: credsOf([
          ['username', auth.ntlm?.username ?? ''],
          ['password', s(auth.ntlm?.password)],
          ['domain', opt(auth.ntlm?.domain)],
          ['workstation', opt(auth.ntlm?.workstation)],
        ]),
      };
    case 'oauth1': {
      const o = auth.oauth1;
      return {
        type: 'oauth1',
        credentials: credsOf([
          ['consumerKey', o?.consumerKey ?? ''],
          ['consumerSecret', s(o?.consumerSecret)],
          ['token', s(o?.accessToken) || undefined],
          ['tokenSecret', s(o?.accessTokenSecret) || undefined],
          ['signatureMethod', o?.signatureMethod],
          ['realm', opt(o?.realm)],
          ['nonce', opt(o?.nonce)],
          ['timestamp', opt(o?.timestamp)],
          ['addParamsToHeader', o?.addParamsToBody ? 'false' : undefined],
        ]),
      };
    }
    case 'oauth2': {
      const o = auth.oauth2;
      const dropped: string[] = [];
      if (o?.refreshToken !== undefined && s(o.refreshToken) !== '') dropped.push('refreshToken');
      if (o?.grantType === 'device_code') dropped.push('grantType device_code');
      if (o?.deviceAuthorizationUrl) dropped.push('deviceAuthorizationUrl');
      if (o?.issuer) dropped.push('issuer');
      if (o?.scopes?.length) dropped.push('scopes');
      if (o?.expiresAt !== undefined) dropped.push('expiresAt');
      if (dropped.length > 0) ctx.report.dropped('auth-fields', owner, dropped.join(', '));
      return {
        type: 'oauth2',
        credentials: credsOf([
          ['accessToken', s(o?.accessToken)],
          ['tokenType', opt(o?.tokenType)],
          ['grant_type', o?.grantType ? OAUTH2_GRANTS[o.grantType] : undefined],
          ['clientId', opt(o?.clientId)],
          [
            'clientSecret',
            o?.clientSecret !== undefined ? s(o.clientSecret) || undefined : undefined,
          ],
          ['authUrl', opt(o?.authorizationUrl)],
          ['accessTokenUrl', opt(o?.tokenUrl)],
          ['scope', opt(o?.scope)],
          ['redirect_uri', opt(o?.redirectUri)],
          ['username', opt(o?.username)],
          ['password', s(o?.password) || undefined],
        ]),
      };
    }
    case 'wsse':
      ctx.report.dropped('wsse-auth', owner);
      return { type: 'noauth' };
    default:
      return undefined;
  }
}

function isSecretRefValue(v: unknown): v is Exclude<SecretValue, string> {
  return isObj(v) && (v.kind === 'handle' || v.kind === 'external' || v.kind === 'inline');
}

/**
 * A sidecar credential value as file text. Handle conversion
 * (`convertPostmanBagToHandles`) leaves `{ kind: 'handle', id, label }`
 * objects in the bag; like typed fields they go through {@link secretText}
 * (EMPTY + a `secret-handle` entry), so neither the keychain id nor the label
 * (collection / request names) reaches a file. Without a report context
 * (bag-only restores) a handle is still emptied.
 */
function bagValue(v: unknown, owner: string | undefined, ctx: ExportContext | undefined): unknown {
  if (!isSecretRefValue(v)) return v ?? '';
  if (ctx && owner !== undefined) return secretText(v, owner, ctx);
  return v.kind === 'inline' ? v.value : '';
}

/** v2-shaped sidecar auth `{ type, [type]: [{ key, value }] }` → credential rows. */
function sidecarCreds(
  raw: unknown,
  owner?: string,
  ctx?: ExportContext
): { type: string; creds: Cred[] } | undefined {
  if (!isObj(raw) || typeof raw.type !== 'string') return undefined;
  const type = raw.type;
  const block = Object.prototype.hasOwnProperty.call(raw, type) ? raw[type] : undefined;
  const creds: Cred[] = Array.isArray(block)
    ? block.filter(isObj).map((c) => ({ key: str(c.key), value: bagValue(c.value, owner, ctx) }))
    : isObj(block)
      ? Object.entries(block).map(([key, value]) => ({ key, value: bagValue(value, owner, ctx) }))
      : [];
  return { type, creds };
}

/**
 * Restura auth (+ the sidecar's raw remainder) → one v3 credential set:
 *  - unsupported Postman auth imported as `none` + the whole raw block in the
 *    sidecar is restored verbatim (hawk, jwt, edgegrid, …);
 *  - approximated OAuth1 / OAuth2 get their unmapped keys back (grant type,
 *    RSA key, …);
 *  - `allowed` is the auth-type enum of the target v3 kind: anything else is
 *    exported as `noauth` and reported.
 */
export function exportAuth(
  auth: AuthConfig,
  sidecar: PostmanSidecar | undefined,
  allowed: ReadonlySet<string>,
  owner: string,
  ctx: ExportContext
): Raw | undefined {
  const bag = sidecar?.authBagOnly ? undefined : sidecarCreds(sidecar?.auth, owner, ctx);
  let set: Raw | undefined;
  if (auth.type === 'none' && bag && bag.type !== 'noauth' && bag.type !== '') {
    set = { type: bag.type, credentials: bag.creds };
  } else {
    set = typedAuthToV3(auth, owner, ctx);
    if (set && bag && bag.type === set.type && Array.isArray(set.credentials)) {
      const have = new Set((set.credentials as Cred[]).map((c) => c.key));
      for (const c of bag.creds) if (!have.has(c.key)) (set.credentials as Cred[]).push(c);
    }
  }
  if (!set) return undefined;
  if (set.type !== 'noauth' && !allowed.has(str(set.type))) {
    ctx.report.dropped('auth-unsupported-for-kind', owner, str(set.type));
    return { type: 'noauth' };
  }
  if (sidecar?.authSets !== undefined) ctx.report.approximated('multi-auth', owner);
  return set;
}

/** Bag-only auth (broker presets, placeholder items) → v3 credential set. */
export function restoreBagOnlyAuth(
  sidecar: PostmanSidecar | undefined,
  allowed: ReadonlySet<string>
): Raw | undefined {
  if (!sidecar?.authBagOnly) return undefined;
  const bag = sidecarCreds(sidecar.auth);
  if (!bag || bag.type === '') return undefined;
  if (bag.type === 'noauth') return { type: 'noauth' };
  if (!allowed.has(bag.type)) return undefined;
  return { type: bag.type, credentials: bag.creds };
}

const CREDENTIAL_TYPES = [
  'basic',
  'bearer',
  'apikey',
  'oauth1',
  'oauth2',
  'jwt',
  'ntlm',
  'digest',
  'edgegrid',
  'hawk',
  'asap',
  'awsv4',
];

/** Auth-type enums per v3 kind (vendor/postman/v3.0.0/schema.json). */
export const AUTH_TYPES = {
  collection: new Set([...CREDENTIAL_TYPES, 'sasl']),
  http: new Set(CREDENTIAL_TYPES),
  graphql: new Set(CREDENTIAL_TYPES),
  grpc: new Set(['basic', 'bearer', 'apikey', 'oauth2']),
  mcp: new Set(['basic', 'bearer', 'oauth2']),
  mqtt: new Set(['basic']),
  kafka: new Set(['sasl', 'awsv4', 'oauth2', 'bearer']),
  websocket: new Set(CREDENTIAL_TYPES),
  llm: new Set(['basic', 'bearer', 'apikey', 'awsv4', 'azure']),
} as const;

/**
 * Stable structural equality for auth configs (inheritance detection). A
 * secret ref collapses with another only when it is provably the same secret:
 * inline refs compare as their plaintext (equal to a plain string of the same
 * value); keychain handles by `id`; external refs by provider / profile /
 * secret / selector. Labels never count. Anything else stays distinct — a
 * false "same" exports the request as inherit, so on re-import it would use
 * the ancestor's credential (misrouting). Desktop handle conversion
 * (`convertCollectionSecretsToHandles`) mints a fresh id per location with no
 * provenance marker, so such requests export an explicit, blank-secret block.
 */
export function sameAuth(a: AuthConfig | undefined, b: AuthConfig | undefined): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isObj(v)) return v;
  // Tagged objects: never equal to a plain string (e.g. a blank folder token).
  if (v.kind === 'handle') return { '\u0000handle': str(v.id) };
  if (v.kind === 'external') {
    return {
      '\u0000external': [v.provider, v.profileId, v.secretId, v.selector ?? null].map((x) =>
        typeof x === 'string' ? x : null
      ),
    };
  }
  if (v.kind === 'inline' && typeof v.value === 'string') return v.value;
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => [k, sortKeys(v[k])])
  );
}
