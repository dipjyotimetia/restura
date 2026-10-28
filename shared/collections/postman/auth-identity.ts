import { isConfiguredAuth } from '../../auth/inheritance';
import type { AuthConfig } from '../../types';
import type { PostmanSidecar } from './sidecar';

// Leaf module (no `./common` import): the desktop handle conversion in
// `src/lib/shared/secretRef-migrations.ts` uses these, and it is reachable from
// the `exactOptionalPropertyTypes` program of `src/features/http/tsconfig.json`.

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);

/** Same as `str` in `./common`. */
function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
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
 * Stable structural equality for auth configs (inheritance detection). A
 * secret ref collapses with another only when it is provably the same secret:
 * inline refs compare as their plaintext (equal to a plain string of the same
 * value); keychain handles by `id`; external refs by provider / profile /
 * secret / selector. Labels never count. Anything else stays distinct — a
 * false "same" exports the request as inherit, so on re-import it would use
 * the ancestor's credential (misrouting). Desktop handle conversion
 * (`convertCollectionSecretsToHandles`) keeps inheritance detectable without
 * loosening this check: a request whose whole auth equals its nearest
 * ancestor's (by plaintext, before conversion) reuses that ancestor's handle
 * ids, so it still compares equal here and exports as inherit (#1226). Any
 * other handle pair (distinct ids) stays distinct and exports explicitly.
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
