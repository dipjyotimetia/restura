import { isConfiguredAuth } from '../../auth/inheritance';
import type { AuthConfig } from '../../types';
import { arr, isObj, type Raw, str } from './common';
import { requestAuth } from './export-v3-http';
import { type ExportContext, exportAuth } from './export-v3-shared';
import type { PostmanSidecar } from './sidecar';
import type { PostmanV21Auth, PostmanV21AuthAttribute } from './v21-types';

/**
 * Restura auth → Postman v2.1 `auth` blocks (#1229): the inverse of
 * `auth.ts` (`convertPostmanAuth` + `unmappedAuthRemainder`).
 *
 * The typed mapping and the sidecar precedence are shared with v3 export
 * (`exportAuth` in `export-v3-shared.ts`): a configured Restura auth always
 * wins; the sidecar only adds back the keys the importer could not map, or
 * restores an unsupported Postman type when the Restura auth is `none`. Here
 * the resulting `{ type, credentials }` set is written in the v2.1
 * `{ type, [type]: [{ key, value, type }] }` shape.
 */

/** `auth.type` enum of `vendor/postman/v2.1.0/schema.json` (no jwt / asap). */
export const V21_AUTH_TYPES: ReadonlySet<string> = new Set<PostmanV21Auth['type']>([
  'apikey',
  'awsv4',
  'basic',
  'bearer',
  'digest',
  'edgegrid',
  'hawk',
  'noauth',
  'oauth1',
  'oauth2',
  'ntlm',
]);

function isV21AuthType(type: string): type is PostmanV21Auth['type'] {
  return V21_AUTH_TYPES.has(type);
}

/**
 * The attribute `type` of each key the sidecar kept (so a restored block is
 * byte-equivalent to the imported one). `undefined` = not a sidecar key.
 */
function sidecarAttributeTypes(
  sidecar: PostmanSidecar | undefined
): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  const raw = sidecar?.authBagOnly ? undefined : sidecar?.auth;
  if (!isObj(raw) || typeof raw.type !== 'string') return out;
  const block = Object.prototype.hasOwnProperty.call(raw, raw.type) ? raw[raw.type] : undefined;
  if (Array.isArray(block)) {
    for (const entry of block) {
      if (isObj(entry) && typeof entry.key === 'string') {
        out.set(entry.key, typeof entry.type === 'string' ? entry.type : undefined);
      }
    }
  } else if (isObj(block)) {
    for (const key of Object.keys(block)) out.set(key, undefined);
  }
  return out;
}

/**
 * Grants the importer approximates (`mapPostmanGrantType` in auth.ts) → the
 * typed grant they import as. While the typed grant is still that value the
 * user has not changed it, so the original Postman grant is restored.
 */
const GRANT_APPROXIMATION: Readonly<Record<string, string>> = {
  authorization_code_with_pkce: 'authorization_code',
};

function sidecarGrant(sidecar: PostmanSidecar | undefined): string | undefined {
  const raw = sidecar?.authBagOnly ? undefined : sidecar?.auth;
  if (!isObj(raw) || raw.type !== 'oauth2' || !Array.isArray(raw.oauth2)) return undefined;
  const entry = raw.oauth2.find((e) => isObj(e) && e.key === 'grant_type');
  const value = isObj(entry) ? entry.value : undefined;
  return typeof value === 'string' && GRANT_APPROXIMATION[value] ? value : undefined;
}

/** A v3-shaped credential set (`exportAuth` output) → a v2.1 auth block. */
function toV21Auth(
  set: Raw | undefined,
  sidecar: PostmanSidecar | undefined
): PostmanV21Auth | undefined {
  if (!set) return undefined;
  const type = str(set.type);
  // `exportAuth` already reported a type outside V21_AUTH_TYPES.
  if (!isV21AuthType(type) || type === 'noauth') return { type: 'noauth' };
  const kept = sidecarAttributeTypes(sidecar);
  const keptGrant = type === 'oauth2' ? sidecarGrant(sidecar) : undefined;
  const attributes: PostmanV21AuthAttribute[] = arr(set.credentials)
    .filter(isObj)
    .map((c) => {
      const key = str(c.key);
      const restoreGrant =
        key === 'grant_type' &&
        keptGrant !== undefined &&
        c.value === GRANT_APPROXIMATION[keptGrant];
      const value = restoreGrant ? keptGrant : c.value;
      const attrType = kept.has(key) ? kept.get(key) : 'string';
      return attrType === undefined ? { key, value } : { key, value, type: attrType };
    });
  const auth: PostmanV21Auth = { type };
  (auth as unknown as Record<string, unknown>)[type] = attributes;
  return auth;
}

/**
 * What a container hands its children for inheritance detection, v2.1 flavour
 * of `authForChildren` in `export-v3.ts`. A container whose Postman auth was
 * unsupported (hawk, jwt, …; imported as `none` + sidecar) cuts the chain:
 *  - a type v2.1 can hold (hawk, edgegrid) is restored on the container, so
 *    its inheriting children export WITHOUT `auth` (Postman signs them with it);
 *  - a type v2.1 cannot hold (jwt, asap) is reported and the container is
 *    written as `noauth`; its inheriting children get an explicit `noauth`
 *    too, so a re-import can never hand them a credential from further up.
 */
export type V21Inherited = AuthConfig | undefined | typeof AUTH_CUT;
export const AUTH_CUT: unique symbol = Symbol('postman-v21-auth-cut');

export function v21AuthForChildren(
  node: { auth?: AuthConfig; _postman?: PostmanSidecar },
  unsupported: string | undefined,
  inherited: V21Inherited
): V21Inherited {
  if (unsupported) return V21_AUTH_TYPES.has(unsupported) ? { type: 'none' } : AUTH_CUT;
  return isConfiguredAuth(node.auth) ? node.auth : inherited;
}

/** Collection / folder auth (`containerAuth` in `export-v3.ts`, v2.1 shape). */
export function v21ContainerAuth(
  auth: AuthConfig | undefined,
  sidecar: PostmanSidecar | undefined,
  owner: string,
  ctx: ExportContext,
  emitNone: boolean
): PostmanV21Auth | undefined {
  const bagAuth = sidecar?.auth !== undefined && !sidecar.authBagOnly;
  if (!bagAuth && !isConfiguredAuth(auth) && !(emitNone && auth)) return undefined;
  return toV21Auth(
    exportAuth(auth ?? { type: 'none' }, sidecar, V21_AUTH_TYPES, owner, ctx),
    sidecar
  );
}

/**
 * Request auth: omitted (Postman `inherit`) when it equals what the importer
 * bakes in from the nearest ancestor; see `requestAuth` in
 * `export-v3-http.ts` for the full rule, which this delegates to.
 */
export function v21RequestAuth(
  auth: AuthConfig,
  inherited: V21Inherited,
  sidecar: PostmanSidecar | undefined,
  owner: string,
  ctx: ExportContext
): PostmanV21Auth | undefined {
  let parent: AuthConfig | undefined;
  if (inherited === AUTH_CUT) {
    const bagAuth = sidecar?.auth !== undefined && !sidecar.authBagOnly;
    if (!bagAuth && !isConfiguredAuth(auth)) return { type: 'noauth' };
    parent = { type: 'none' };
  } else {
    parent = inherited;
  }
  return toV21Auth(requestAuth(auth, parent, sidecar, V21_AUTH_TYPES, owner, ctx), sidecar);
}
