import type { AuthConfig } from '../../types';
import type { PostmanUnmodelledConstruct } from './report';

/**
 * Postman auth → Restura `AuthConfig`, shared by every Postman format version.
 *
 * Callers first normalise their version's parameter encoding into a flat
 * `key → string` map (`authParamsV2` handles both v2.1's `[{ key, value }]`
 * array and v2.0's plain object), then call {@link convertPostmanAuth}.
 */

export type PostmanAuthParams = ReadonlyMap<string, string>;

export type AuthConversion =
  | { status: 'ok'; auth: AuthConfig }
  /** Mapped, but some Postman options could not be represented. */
  | { status: 'approximated'; auth: AuthConfig; construct: PostmanUnmodelledConstruct }
  /** No Restura equivalent (hawk, edgegrid, jwt, akamai, asap, …): degrades to none. */
  | { status: 'unsupported'; auth: AuthConfig; authType: string }
  /** `inherit` (or a missing type): use the parent's auth. */
  | { status: 'inherit' };

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** Normalise a v2.0 (object map) or v2.1 (`[{ key, value }]`) auth parameter block. */
export function authParamsV2(block: unknown): PostmanAuthParams {
  const out = new Map<string, string>();
  if (Array.isArray(block)) {
    for (const entry of block) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { key?: unknown }).key === 'string'
      ) {
        const { key, value } = entry as { key: string; value?: unknown };
        out.set(key, stringify(value));
      }
    }
  } else if (block && typeof block === 'object') {
    for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
      out.set(key, stringify(value));
    }
  }
  return out;
}

/**
 * Postman auth parameter keys that {@link convertPostmanAuth} copies into the
 * typed `AuthConfig`, per type. A type listed here is "typed": its mapped
 * credentials live (and are handle-converted / redacted / counted) on the
 * typed model, so they must NEVER be duplicated into the `_postman` sidecar
 * (ADR-0007): the sidecar keeps only the remaining, unmapped keys. Types not
 * listed are unsupported — their whole block is bag-only.
 *
 * `signatureMethod` / `grant_type` are deliberately absent: they are what the
 * approximation is about, and are not secrets.
 */
export const POSTMAN_MAPPED_AUTH_PARAMS: Readonly<Record<string, ReadonlySet<string>>> = {
  noauth: new Set(),
  inherit: new Set(),
  basic: new Set(['username', 'password']),
  bearer: new Set(['token']),
  apikey: new Set(['key', 'value', 'in']),
  digest: new Set(['username', 'password']),
  awsv4: new Set(['accessKey', 'secretKey', 'region', 'service']),
  ntlm: new Set(['username', 'password', 'domain', 'workstation']),
  oauth1: new Set([
    'consumerKey',
    'consumerSecret',
    'token',
    'tokenSecret',
    'realm',
    'nonce',
    'timestamp',
  ]),
  oauth2: new Set([
    'accessToken',
    'tokenType',
    'clientId',
    'clientSecret',
    'authUrl',
    'accessTokenUrl',
    'scope',
    'redirect_uri',
    'username',
    'password',
  ]),
};

/**
 * The raw Postman auth block minus every key already mapped into the typed
 * model (see {@link POSTMAN_MAPPED_AUTH_PARAMS}). Unsupported types keep
 * their whole active block. Sibling (inactive) type blocks are always dropped. Works on both v2.1 arrays and v2.0 object maps.
 */
export function unmappedAuthRemainder(raw: Record<string, unknown>): Record<string, unknown> {
  const type = typeof raw.type === 'string' ? raw.type : '';
  const mapped = POSTMAN_MAPPED_AUTH_PARAMS[type];
  // Only the ACTIVE type's block is kept. Postman ignores sibling blocks
  // (`bearer: [...]` next to `type: 'hawk'`), but they can still hold
  // credentials, so they are dropped rather than carried in the sidecar.
  if (!mapped) return { type, [type]: raw[type] };
  const block = raw[type];
  let rest: unknown = block;
  if (Array.isArray(block)) {
    rest = block.filter(
      (e) => !(e && typeof e === 'object' && mapped.has(String((e as { key?: unknown }).key)))
    );
  } else if (block && typeof block === 'object') {
    rest = Object.fromEntries(
      Object.entries(block as Record<string, unknown>).filter(([k]) => !mapped.has(k))
    );
  }
  return { type, [type]: rest };
}

const OAUTH1_SIGNATURE_METHODS = new Set(['HMAC-SHA1', 'HMAC-SHA256', 'PLAINTEXT']);

/**
 * `T` with every possibly-undefined property made optional-and-defined, so the
 * result is assignable under `exactOptionalPropertyTypes` (on in
 * `src/features/http/tsconfig.json`, which reaches this file transitively).
 */
type Compact<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Drop keys whose value is `undefined` so consumers see only what was set. */
function compact<T extends object>(obj: T): Compact<T> {
  for (const k of Object.keys(obj) as Array<keyof T>) {
    if (obj[k] === undefined) delete obj[k];
  }
  return obj as Compact<T>;
}

export function convertPostmanAuth(type: string, params: PostmanAuthParams): AuthConversion {
  const get = (key: string): string => params.get(key) ?? '';
  const opt = (key: string): string | undefined => {
    const v = params.get(key);
    return v !== undefined && v.length > 0 ? v : undefined;
  };

  switch (type) {
    case 'inherit':
    case '':
      return { status: 'inherit' };
    case 'noauth':
      return { status: 'ok', auth: { type: 'none' } };
    case 'basic':
      return {
        status: 'ok',
        auth: { type: 'basic', basic: { username: get('username'), password: get('password') } },
      };
    case 'bearer':
      return { status: 'ok', auth: { type: 'bearer', bearer: { token: get('token') } } };
    case 'apikey':
      return {
        status: 'ok',
        auth: {
          type: 'api-key',
          apiKey: {
            key: get('key'),
            value: get('value'),
            in: get('in') === 'query' ? 'query' : 'header',
          },
        },
      };
    case 'digest':
      return {
        status: 'ok',
        auth: { type: 'digest', digest: { username: get('username'), password: get('password') } },
      };
    case 'awsv4':
      return {
        status: 'ok',
        auth: {
          type: 'aws-signature',
          awsSignature: {
            accessKey: get('accessKey'),
            secretKey: get('secretKey'),
            region: get('region'),
            service: get('service'),
          },
        },
      };
    case 'ntlm':
      return {
        status: 'ok',
        auth: {
          type: 'ntlm',
          ntlm: compact({
            username: get('username'),
            password: get('password'),
            domain: opt('domain'),
            workstation: opt('workstation'),
          }),
        },
      };
    case 'oauth1': {
      const method = opt('signatureMethod');
      const supportedMethod = method === undefined || OAUTH1_SIGNATURE_METHODS.has(method);
      const oauth1: NonNullable<AuthConfig['oauth1']> = compact({
        consumerKey: get('consumerKey'),
        consumerSecret: get('consumerSecret'),
        accessToken: opt('token'),
        accessTokenSecret: opt('tokenSecret'),
        signatureMethod: supportedMethod
          ? (method as NonNullable<AuthConfig['oauth1']>['signatureMethod'])
          : undefined,
        realm: opt('realm'),
        nonce: opt('nonce'),
        timestamp: opt('timestamp'),
      });
      const auth: AuthConfig = { type: 'oauth1', oauth1 };
      // RSA signing (privateKey) and body/URL placement have no Restura equivalent.
      const approximated =
        !supportedMethod || opt('privateKey') !== undefined || get('addParamsToHeader') === 'false';
      return approximated
        ? { status: 'approximated', auth, construct: 'oauth1-options' }
        : { status: 'ok', auth };
    }
    case 'oauth2': {
      const grant = opt('grant_type');
      const oauth2: NonNullable<AuthConfig['oauth2']> = compact({
        accessToken: get('accessToken'),
        tokenType: opt('tokenType'),
        grantType: mapPostmanGrantType(grant),
        clientId: opt('clientId'),
        clientSecret: opt('clientSecret'),
        authorizationUrl: opt('authUrl'),
        tokenUrl: opt('accessTokenUrl'),
        scope: opt('scope'),
        redirectUri: opt('redirect_uri'),
        username: opt('username'),
        password: opt('password'),
      });
      const auth: AuthConfig = { type: 'oauth2', oauth2 };
      return grant === 'implicit' || grant === 'authorization_code_with_pkce'
        ? { status: 'approximated', auth, construct: 'oauth2-grant' }
        : { status: 'ok', auth };
    }
    default:
      return { status: 'unsupported', auth: { type: 'none' }, authType: type };
  }
}

/**
 * Map a Postman `grant_type` to `AuthConfig.oauth2.grantType`. PKCE collapses
 * to plain authorization_code; implicit is not modelled (undefined → runtime
 * default). Both are reported as approximations by {@link convertPostmanAuth}.
 */
function mapPostmanGrantType(
  p: string | undefined
): NonNullable<AuthConfig['oauth2']>['grantType'] {
  switch (p) {
    case 'authorization_code':
    case 'authorization_code_with_pkce':
      return 'authorization_code';
    case 'client_credentials':
      return 'client_credentials';
    case 'password_credentials':
      return 'password';
    default:
      return undefined;
  }
}
