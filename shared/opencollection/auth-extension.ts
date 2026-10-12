import type { AuthConfig, Collection, CollectionItem } from '../types';

/**
 * `extensions['x-restura-auth']` — Restura-owned, collection-level carrier for
 * the auth knobs the OpenCollection JSON schema has no slot for. The schema's
 * `AuthOAuth1` / `AuthNTLM` / `AuthWsse` objects are `additionalProperties:
 * false` (the VS Code extension validates `opencollection.yml` against it), and
 * neither request items, folders nor `RequestDefaults` accept an extension
 * key — so these cannot ride inline on the auth block or on the item:
 *
 * ```yaml
 * extensions:
 *   x-restura-auth:
 *     entries:
 *       - target: collection         # root request.auth
 *         path: []
 *         type: ntlm
 *         workstation: WS01
 *       - target: folder             # folder request.auth
 *         path: [Secure]
 *         type: wsse
 *         passwordType: PasswordText
 *       - target: request            # item auth (HTTP/GraphQL/gRPC/SSE/MCP)
 *         path: [Folder, Create user]
 *         type: oauth1
 *         addParamsToBody: true
 * ```
 *
 * Same shape/keying as `x-restura-grpc` (folder names + item name, matched in
 * document order so duplicate names resolve positionally). An entry also
 * carries the auth `type` and only applies to a node whose imported auth has
 * that type, so a stale or hand-edited entry can never graft a field onto a
 * different auth block.
 */
export const AUTH_EXTENSION_KEY = 'x-restura-auth';

type AuthTarget = 'collection' | 'folder' | 'request';

interface AuthExtras {
  addParamsToBody?: boolean;
  workstation?: string;
  passwordType?: 'PasswordDigest' | 'PasswordText';
}

interface AuthExtensionEntry extends AuthExtras {
  target: AuthTarget;
  path: string[];
  type: 'oauth1' | 'ntlm' | 'wsse';
}

export interface AuthExtension {
  entries: AuthExtensionEntry[];
}

/** The schema-less knobs of an auth config, or undefined when none are set. */
function extrasOf(
  a: AuthConfig | undefined
): Omit<AuthExtensionEntry, 'target' | 'path'> | undefined {
  if (!a) return undefined;
  if (a.type === 'oauth1' && a.oauth1?.addParamsToBody !== undefined) {
    return { type: 'oauth1', addParamsToBody: a.oauth1.addParamsToBody };
  }
  if (a.type === 'ntlm' && a.ntlm?.workstation !== undefined) {
    return { type: 'ntlm', workstation: a.ntlm.workstation };
  }
  if (a.type === 'wsse' && a.wsse?.passwordType !== undefined) {
    return { type: 'wsse', passwordType: a.wsse.passwordType };
  }
  return undefined;
}

/**
 * Copy of an auth config without the sidecar-carried knobs — the part that
 * lives in the schema-valid OC auth block. Used by the export staleness gates
 * (the sidecar is compared separately).
 */
export function stripAuthExtras(a: AuthConfig): AuthConfig {
  if (a.type === 'oauth1' && a.oauth1 && 'addParamsToBody' in a.oauth1) {
    const { addParamsToBody: _drop, ...rest } = a.oauth1;
    return { ...a, oauth1: rest };
  }
  if (a.type === 'ntlm' && a.ntlm && 'workstation' in a.ntlm) {
    const { workstation: _drop, ...rest } = a.ntlm;
    return { ...a, ntlm: rest };
  }
  if (a.type === 'wsse' && a.wsse && 'passwordType' in a.wsse) {
    const { passwordType: _drop, ...rest } = a.wsse;
    return { ...a, wsse: rest };
  }
  return a;
}

function walk(
  items: CollectionItem[] | undefined,
  parents: string[],
  visit: (target: AuthTarget, path: string[], auth: AuthConfig | undefined) => void
): void {
  for (const it of items ?? []) {
    const path = [...parents, it.name];
    if (it.type === 'folder') {
      visit('folder', path, it.auth);
      walk(it.items, path, visit);
      continue;
    }
    if (it.request) visit('request', path, it.request.auth);
  }
}

const sortKey = (e: AuthExtensionEntry) => JSON.stringify([e.target, e.path]);

/**
 * Build the extension from the internal collection; undefined when no node
 * carries a schema-less knob. Entries are sorted by (target, path) — a stable
 * sort, so duplicate names keep document order — making the output
 * independent of where import re-placed SSE/MCP items within a folder.
 */
export function buildAuthExtension(
  c: Pick<Collection, 'auth' | 'items'>
): AuthExtension | undefined {
  const entries: AuthExtensionEntry[] = [];
  const visit = (target: AuthTarget, path: string[], auth: AuthConfig | undefined) => {
    const extras = extrasOf(auth);
    if (extras) entries.push({ target, path, ...extras });
  };
  visit('collection', [], c.auth);
  walk(c.items, [], visit);
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  return { entries };
}

function isEntry(e: unknown): e is AuthExtensionEntry {
  if (!e || typeof e !== 'object') return false;
  const r = e as Record<string, unknown>;
  return (
    (r.target === 'collection' || r.target === 'folder' || r.target === 'request') &&
    Array.isArray(r.path) &&
    r.path.every((p) => typeof p === 'string') &&
    (r.type === 'oauth1' || r.type === 'ntlm' || r.type === 'wsse')
  );
}

function applyExtras(auth: AuthConfig, e: AuthExtensionEntry): void {
  if (auth.type === 'oauth1' && auth.oauth1 && typeof e.addParamsToBody === 'boolean') {
    auth.oauth1.addParamsToBody = e.addParamsToBody;
  } else if (auth.type === 'ntlm' && auth.ntlm && typeof e.workstation === 'string') {
    auth.ntlm.workstation = e.workstation;
  } else if (
    auth.type === 'wsse' &&
    auth.wsse &&
    (e.passwordType === 'PasswordDigest' || e.passwordType === 'PasswordText')
  ) {
    auth.wsse.passwordType = e.passwordType;
  }
}

/**
 * Re-apply `x-restura-auth` onto an imported internal collection (mutates the
 * auth blocks in place). Malformed entries, unknown paths and type mismatches
 * are ignored — the auth simply keeps its schema defaults.
 */
export function applyAuthExtension(c: Pick<Collection, 'auth' | 'items'>, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const list = (raw as { entries?: unknown }).entries;
  const pending = (Array.isArray(list) ? list : []).filter(isEntry);
  if (pending.length === 0) return;
  const visit = (target: AuthTarget, path: string[], auth: AuthConfig | undefined) => {
    if (!auth) return;
    const k = JSON.stringify(path);
    const idx = pending.findIndex(
      (e) => e.target === target && e.type === auth.type && JSON.stringify(e.path) === k
    );
    if (idx < 0) return;
    const [entry] = pending.splice(idx, 1);
    if (entry) applyExtras(auth, entry);
  };
  visit('collection', [], c.auth);
  walk(c.items, [], visit);
}
