import type {
  AuthConfig,
  Collection,
  CollectionItem,
  CollectionRequest,
  GrpcMethodType,
  GrpcRequest,
  HttpRequest,
  KeyValue,
  RequestBody,
} from '../types';
import { AUTH_EXTENSION_KEY, buildAuthExtension, stripAuthExtras } from './auth-extension';
import { authFromInternal, unwrapAuthForCompare } from './auth-from-internal';
import { KAFKA_EXTENSION_KEY, MQTT_EXTENSION_KEY } from './broker-items';
import {
  buildScripts,
  collectNestedStreamItems,
  type ExtensionLists,
  nonEmpty,
  pushStreamItem,
  runtimeFromInternal,
} from './extension-items';
import { graphqlDocumentFromInternal, graphqlMethodToOC } from './graphql-item';
import { buildGraphQLExtension, GRAPHQL_EXTENSION_KEY } from './graphql-schema-extension';
import { buildGrpcExtension, GRPC_EXTENSION_KEY } from './grpc-schema-extension';
import { buildHttpExtension, HTTP_EXTENSION_KEY } from './http-settings-extension';
import { kvFromInternal } from './key-value';
import type { OpenCollection } from './schemas';
import {
  buildWebSocketExtension,
  SOCKETIO_EXTENSION_KEY,
  WEBSOCKET_EXTENSION_KEY,
  webSocketToOC,
} from './stream-items';
import { authToInternal, groupScripts, ocVariableToKeyValue } from './to-internal';

/**
 * Bridge from Restura internal `Collection` (and its `_oc` passthrough bags) →
 * OpenCollection (v1.0.0). Inverse of `to-internal.ts`.
 *
 * Strategy is layered for diff-friendliness:
 *
 *   1. **Whole-collection shortcut.** If every level still has its `_oc` bag
 *      AND the collection itself has `_oc` (i.e. nothing was edited),
 *      return the cached OC verbatim. Byte-identical to the input.
 *   2. **Root-preserving rebuild.** If the collection has `_oc` but some
 *      items were edited, the rebuild starts from the cached root (so
 *      `info` extras, `config` extras, `docs`, request defaults, and any
 *      non-restura extensions survive) and only the `items` array plus
 *      Restura-managed extensions (`x-restura-sse` / `x-restura-mcp` /
 *      `x-restura-auth`) get replaced with fresh values. Unknown extensions
 *      survive unchanged because the merge keeps every non-restura-managed key
 *      from the cached extensions bag.
 *   3. **Synthesise from scratch.** No `_oc` on the collection — likely
 *      authored in-app rather than imported. Build a minimal OC document
 *      from the internal model alone.
 *
 * Per-item, every emitter falls back to `wit._oc ?? rebuild()` so unmodified
 * items always emit verbatim regardless of which strategy fires above.
 *
 * Special cases mirroring `to-internal.ts`:
 *   - Internal HttpRequest with `body.type === 'graphql'` is emitted as a
 *     native OC GraphQL item, including its query and variables envelope.
 *   - SSE / MCP requests do not live in the OC `items` array; they go into
 *     `extensions['x-restura-sse']` / `extensions['x-restura-mcp']`, with a
 *     `folderPath` (ancestor folder names) when nested in a folder (#866).
 *   - WebSocket connections (#1209) are native OC `websocket` items; their
 *     Restura-only fields go to `extensions['x-restura-websocket']`. Socket.IO
 *     connections go to `extensions['x-restura-socketio']` (folderPath).
 *   - Auth name conversions: internal `api-key`/`aws-signature` ↔ OC
 *     `apikey`/`awsv4`.
 *   - OAuth1 `addParamsToBody`, NTLM `workstation` and WSSE `passwordType`
 *     have no slot in the schema's (closed) auth objects; they are emitted in
 *     `extensions['x-restura-auth']` keyed by node path (auth-extension.ts).
 *   - Method type conversions: internal hyphenated ↔ OC camelCase.
 */

type WithOC<T> = T & { _oc?: unknown };

export function internalToOC(c: WithOC<Collection>): OpenCollection {
  // Strategy 1 — whole-collection shortcut. Gated on three kinds of freshness:
  //  - bag presence (allItemsHaveOcBag): an edited/added item drops its bag,
  //    and `useCollectionStore` strips the `_oc` bag of every ancestor folder
  //    on edit/add/remove/move — so any nested change defeats this.
  //  - auth (authUnchanged / allFolderAuthsUnchanged): default auth lives on the
  //    root/folder bags, so an in-app auth edit must defeat the shortcut.
  //  - root structure (rootStructureUnchanged): a ROOT-level removal strips no
  //    bag (the store's ancestorPath is empty at root) and every survivor keeps
  //    its bag, so only a root count reconciliation sees the deletion. Without
  //    it the cached document re-emits the removed item (GH #278). Nested
  //    removals are already covered by the ancestor-strip above, so no folder
  //    structural check is needed here.
  //  - scripts (scriptsUnchanged / allFolderScriptsUnchanged): collection/folder
  //    pre-request/test scripts live on the root/folder bags, so an in-app
  //    script edit must defeat the shortcut — gated independently of auth so a
  //    script-only edit never recomputes un-modellable auth.
  if (
    c._oc &&
    allItemsHaveOcBag(c.items) &&
    authUnchanged(c._oc, c.auth) &&
    rootMetadataUnchanged(c) &&
    allFolderAuthsUnchanged(c.items) &&
    rootStructureUnchanged(c) &&
    scriptsUnchanged(c._oc, c.preRequestScript, c.testScript) &&
    allFolderScriptsUnchanged(c.items) &&
    allFolderVariablesUnchanged(c.items) &&
    authExtensionUnchanged(c)
  ) {
    return c._oc as OpenCollection;
  }

  const lists: ExtensionLists = { sse: [], mcp: [], kafka: [], mqtt: [], socketio: [] };
  const items: unknown[] = [];

  for (const it of c.items ?? []) {
    const wit = it as WithOC<CollectionItem>;
    if (it.type === 'folder') {
      items.push(folderFromInternal(wit, [it.name], lists));
      continue;
    }
    const r = it.request;
    if (!r) continue;

    if (pushStreamItem(wit, [], lists)) continue;
    items.push(wit._oc ?? requestFromInternal(it.name, r));
  }

  // Restura-managed extensions, rebuilt fresh on every export (undefined =
  // omit): SSE/MCP items, the contract, OAuth1/NTLM/WSSE knobs the schema's
  // closed auth objects can't hold (x-restura-auth) and deduped gRPC schema
  // snapshots / timeouts (x-restura-grpc), imported GraphQL schemas
  // (x-restura-graphql) and httpVersion (x-restura-http).
  const managed: Record<string, unknown> = {
    'x-restura-sse': nonEmpty(lists.sse),
    'x-restura-mcp': nonEmpty(lists.mcp),
    [KAFKA_EXTENSION_KEY]: nonEmpty(lists.kafka),
    [MQTT_EXTENSION_KEY]: nonEmpty(lists.mqtt),
    [SOCKETIO_EXTENSION_KEY]: nonEmpty(lists.socketio),
    [WEBSOCKET_EXTENSION_KEY]: buildWebSocketExtension(c.items),
    'x-restura-contract': c.contractSpec,
    [AUTH_EXTENSION_KEY]: buildAuthExtension(c),
    [GRPC_EXTENSION_KEY]: buildGrpcExtension(c.items),
    [GRAPHQL_EXTENSION_KEY]: buildGraphQLExtension(c.items),
    [HTTP_EXTENSION_KEY]: buildHttpExtension(c.items),
  };

  // Strategy 2 — root-preserving rebuild. Start from the cached OC root,
  // replace items + Restura-managed extensions only.
  if (c._oc) {
    const cached = c._oc as OpenCollection;
    const oc: OpenCollection = { ...cached, items };

    // Merge extensions: keep non-restura keys from the cache, overwrite the
    // restura-managed ones with fresh arrays (or remove if empty so the YAML
    // stays compact).
    const cachedExt = (cached.extensions ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...cachedExt };
    for (const k of Object.keys(managed)) delete merged[k];
    for (const [k, v] of Object.entries(managed)) if (v !== undefined) merged[k] = v;
    if (Object.keys(merged).length > 0) oc.extensions = merged;
    else delete oc.extensions;

    // Collection-level default auth: keep the cached `request` bag verbatim
    // when the auth is unchanged (byte-stable); otherwise merge the fresh
    // auth over it so an in-app edit reaches the export.
    if (!authUnchanged(cached, c.auth)) {
      applyRequestDefaultsAuth(oc as Record<string, unknown>, c.auth);
    }
    // Collection-level scripts: same treatment, gated independently so a
    // script-only edit never recomputes auth (preserves un-modellable types).
    if (!scriptsUnchanged(cached, c.preRequestScript, c.testScript)) {
      applyRequestDefaultsScripts(oc as Record<string, unknown>, c.preRequestScript, c.testScript);
    }
    if (!rootMetadataUnchanged(c)) applyRootMetadata(oc, c);

    return oc;
  }

  // Strategy 3 — synthesise from scratch.
  const oc: OpenCollection = {
    opencollection: '1.0.0',
    info: {
      name: c.name,
      ...(c.description ? { summary: c.description } : {}),
    },
    items,
  };

  const rootAuth = authFromInternal(c.auth);
  const rootScripts = buildScripts(c.preRequestScript, c.testScript);
  if (rootAuth || rootScripts) {
    oc.request = {
      ...(rootAuth ? { auth: rootAuth } : {}),
      ...(rootScripts ? { scripts: rootScripts } : {}),
    };
  }

  const extensions = Object.fromEntries(Object.entries(managed).filter(([, v]) => v !== undefined));
  if (Object.keys(extensions).length > 0) oc.extensions = extensions;

  if ((c.variables ?? []).length > 0) {
    oc.config = {
      environments: [
        {
          name: 'default',
          variables: variablesFromInternal(c.variables),
        },
      ],
    };
  }

  return oc;
}

function allItemsHaveOcBag(items: CollectionItem[] | undefined): boolean {
  if (!items) return true;
  return items.every((it) => {
    const wit = it as WithOC<CollectionItem>;
    if (wit._oc === undefined) return false;
    if (it.type === 'folder') return allItemsHaveOcBag(it.items);
    return true;
  });
}

/**
 * Set or clear a single key in a node's OC `request` (RequestDefaults) bag,
 * preserving every other default the bag carried and dropping the bag entirely
 * when the result would be empty (so the YAML stays compact). `fresh ===
 * undefined` clears the key. Shared by the auth and scripts appliers — they are
 * gated independently at the call sites, so this never recomputes one from the
 * other (load-bearing for un-modellable auth, see callers).
 */
function setRequestDefault(node: Record<string, unknown>, key: string, fresh: unknown): void {
  const cachedRequest =
    node.request && typeof node.request === 'object'
      ? { ...(node.request as Record<string, unknown>) }
      : {};
  if (fresh !== undefined) {
    node.request = { ...cachedRequest, [key]: fresh };
    return;
  }
  delete cachedRequest[key];
  if (Object.keys(cachedRequest).length > 0) node.request = cachedRequest;
  else delete node.request;
}

/** Merge a node's internal auth into its OC `request` (RequestDefaults) bag. */
function applyRequestDefaultsAuth(
  node: Record<string, unknown>,
  auth: AuthConfig | undefined
): void {
  setRequestDefault(node, 'auth', authFromInternal(auth));
}

/**
 * Merge a node's internal pre-request / test scripts into its `request` bag.
 * Only the `before-request` / `tests` entries are rebuilt from the internal
 * fields; every other cached script entry (`after-response`, `hooks`, file-ref
 * scripts) is preserved verbatim. Without this, a script-only edit would rewrite
 * the whole `scripts` array and silently drop those un-modellable entries — the
 * script analogue of the un-modellable-auth trap (see {@link authUnchanged}).
 */
function applyRequestDefaultsScripts(
  node: Record<string, unknown>,
  preRequest: string | undefined,
  test: string | undefined
): void {
  const cached = (node.request as { scripts?: unknown } | undefined)?.scripts;
  const preserved = Array.isArray(cached)
    ? cached.filter((s) => {
        const t = (s as { type?: unknown } | null)?.type;
        return t !== 'before-request' && t !== 'tests';
      })
    : [];
  const fresh = buildScripts(preRequest, test) ?? [];
  const merged = [...fresh, ...preserved];
  setRequestDefault(node, 'scripts', merged.length > 0 ? merged : undefined);
}

function folderFromInternal(
  it: WithOC<CollectionItem>,
  folderPath: string[],
  lists: ExtensionLists
): unknown {
  // Verbatim shortcut only while the folder's default auth AND scripts still
  // match the cached bag — an in-app edit to either forces a rebuild (children
  // still fall back to their own _oc bags below, so unmodified requests stay
  // verbatim).
  const authSame = authUnchanged(it._oc, it.auth);
  const scriptsSame = scriptsUnchanged(it._oc, it.preRequestScript, it.testScript);
  const variablesSame = folderVariablesUnchanged(it._oc, it.variables);
  if (it._oc && authSame && scriptsSame && variablesSame) {
    collectNestedStreamItems(it.items, folderPath, lists);
    return it._oc;
  }
  const out: Record<string, unknown> = it._oc
    ? { ...(it._oc as Record<string, unknown>) }
    : { info: { name: it.name } };
  const childItems: unknown[] = [];
  for (const child of it.items ?? []) {
    const wchild = child as WithOC<CollectionItem>;
    if (child.type === 'folder') {
      childItems.push(folderFromInternal(wchild, [...folderPath, child.name], lists));
      continue;
    }
    const r = child.request;
    if (!r) {
      childItems.push(wchild._oc ?? { info: { name: child.name } });
      continue;
    }
    if (pushStreamItem(wchild, folderPath, lists)) continue;
    childItems.push(wchild._oc ?? requestFromInternal(child.name, r));
  }
  out.items = childItems;
  // Apply each independently and only when it actually changed: rebuilding for
  // a script edit must not recompute auth (would drop auth the internal model
  // can't represent — e.g. OAuth1 RSA keys or unknown types — which survives
  // only via the cached _oc bytes), and vice versa.
  if (!authSame) applyRequestDefaultsAuth(out, it.auth);
  if (!scriptsSame) applyRequestDefaultsScripts(out, it.preRequestScript, it.testScript);
  if (!variablesSame) {
    const variables = variablesFromInternal(it.variables);
    setRequestDefault(out, 'variables', variables.length > 0 ? variables : undefined);
  }
  return out;
}

function requestFromInternal(name: string, r: CollectionRequest): unknown {
  switch (r.type) {
    case 'http': {
      const hr = r as HttpRequest;
      if (hr.body.type === 'graphql') {
        const { query, variables } = graphqlDocumentFromInternal(hr.body);
        const graphql: Record<string, unknown> = { ...graphqlMethodToOC(hr.method), url: hr.url };
        if (query) graphql.query = query;
        if (variables !== undefined) graphql.variables = variables;
        if (hr.headers?.length) graphql.headers = hr.headers.map(kvFromInternal);
        const auth = authFromInternal(hr.auth);
        if (auth) graphql.auth = auth;
        const out: Record<string, unknown> = { info: { type: 'graphql', name }, graphql };
        const runtime = runtimeFromInternal(hr.preRequestScript, hr.testScript);
        if (runtime) out.runtime = runtime;
        return out;
      }
      const http: Record<string, unknown> = {
        method: hr.method,
        url: hr.url,
      };
      if (hr.headers?.length) {
        http.headers = hr.headers.map(kvFromInternal);
      }
      if (hr.params?.length) {
        http.params = hr.params.map(kvFromInternal);
      }
      if (hr.body && hr.body.type !== 'none') {
        const body = bodyFromInternal(hr.body);
        if (body !== undefined) http.body = body;
      }
      const auth = authFromInternal(hr.auth);
      if (auth) http.auth = auth;
      const info: Record<string, unknown> = { type: 'http', name };
      if (hr.description) info.description = hr.description;
      const out: Record<string, unknown> = { info, http };
      const runtime = runtimeFromInternal(hr.preRequestScript, hr.testScript);
      if (runtime) out.runtime = runtime;
      return out;
    }
    case 'grpc': {
      const gr = r as GrpcRequest;
      const grpc: Record<string, unknown> = {
        url: gr.url,
        service: gr.service,
        method: gr.method,
        methodType: methodTypeFromInternal(gr.methodType),
      };
      if (gr.message) grpc.message = gr.message;
      if (gr.metadata?.length) {
        grpc.metadata = gr.metadata.map(kvFromInternal);
      }
      const auth = authFromInternal(gr.auth);
      if (auth) grpc.auth = auth;
      const out: Record<string, unknown> = { info: { type: 'grpc', name }, grpc };
      const runtime = runtimeFromInternal(gr.preRequestScript, gr.testScript);
      if (runtime) out.runtime = runtime;
      return out;
    }
    case 'websocket':
      return webSocketToOC(name, r);
    case 'sse':
    case 'mcp':
    case 'kafka':
    case 'mqtt':
    case 'socketio':
      // SSE / MCP / Kafka / MQTT / Socket.IO must be routed into extensions by the caller.
      throw new Error(
        `internalToOC: ${r.type} requests must be emitted via extensions, not requestFromInternal`
      );
  }
}

function bodyFromInternal(body: RequestBody): unknown {
  switch (body.type) {
    case 'json':
      return { raw: { format: 'json', value: body.raw ?? '' } };
    case 'xml':
      return { raw: { format: 'xml', value: body.raw ?? '' } };
    case 'text':
      return { raw: { format: 'text', value: body.raw ?? '' } };
    case 'graphql':
      // Without _oc, the only safe representation is JSON-encoded raw.
      return { raw: { format: 'json', value: body.raw ?? '' } };
    case 'form-data':
      return { multipartForm: { parts: body.formData ?? [] } };
    case 'x-www-form-urlencoded':
      return { formUrlEncoded: { parts: body.formData ?? [] } };
    case 'binary': {
      if (!body.binary) return undefined;
      // A live DOM `File` is not YAML-serializable — dumping it throws and
      // takes the whole export down. Emit a portable descriptor (name + MIME)
      // instead so the export never crashes. The raw bytes aren't carried in
      // the shared text document by design.
      const f = body.binary;
      if (typeof File !== 'undefined' && f instanceof File) {
        return { file: { name: f.name, ...(f.type ? { contentType: f.type } : {}) } };
      }
      return { file: f };
    }
    default:
      return undefined;
  }
}

/**
 * Export-time staleness check for collection/folder default auth. The cached
 * `_oc` bag predates any in-app edit, so before trusting it we convert its
 * `request.auth` through the SAME import pipeline (authToInternal) and
 * deep-compare against the current internal auth (secrets flattened to their
 * exportable strings on both sides). Equal → cached bytes are still true;
 * different → the auth was edited in-app and the cached doc must not be
 * emitted verbatim.
 *
 * The JSON comparison is order-sensitive, which is safe by construction: a
 * false "changed" verdict merely costs byte-stability (we rebuild), while
 * false "unchanged" would require structurally different auth to serialize
 * identically — impossible.
 *
 * Known blind spot: auth types with no internal representation (unknown/
 * future OC types) degrade to 'none' through authToInternal, so cached-vs-
 * current compares none === none and the gate reports "unchanged" no matter
 * what. Untouched documents round-trip byte-stably (desired), but clearing
 * such an auth in-app resurrects the original block on an include-secrets
 * export. OAuth1/NTLM/WSSE are modelled natively since #869 and are no longer
 * affected; a treat-degraded-as-changed heuristic would instead drop the
 * remaining unknown types on every round-trip.
 */
function authUnchanged(cachedNode: unknown, internalAuth: AuthConfig | undefined): boolean {
  const cachedRequest = (cachedNode as { request?: unknown } | undefined)?.request;
  const cachedAuth = (cachedRequest as { auth?: unknown } | undefined)?.auth;
  // Compare only the schema-visible part: the OC auth block never carries the
  // x-restura-auth knobs, so they are gated by authExtensionUnchanged instead.
  const cachedInternal = unwrapAuthForCompare(stripAuthExtras(authToInternal(cachedAuth)));
  const currentInternal = unwrapAuthForCompare(stripAuthExtras(internalAuth ?? { type: 'none' }));
  return JSON.stringify(cachedInternal) === JSON.stringify(currentInternal);
}

/**
 * True when the cached document's `x-restura-auth` still matches the internal
 * tree. An edit to a schema-less knob (e.g. NTLM workstation on the collection
 * or a folder) leaves the OC auth block — and thus authUnchanged — untouched,
 * so the verbatim shortcut must also gate on the sidecar.
 */
function authExtensionUnchanged(c: WithOC<Collection>): boolean {
  const cached = (
    (c._oc as OpenCollection | undefined)?.extensions as Record<string, unknown> | undefined
  )?.[AUTH_EXTENSION_KEY];
  return JSON.stringify(cached) === JSON.stringify(buildAuthExtension(c));
}

/** Recursively true when every folder's auth still matches its cached bag. */
function allFolderAuthsUnchanged(items: CollectionItem[] | undefined): boolean {
  if (!items) return true;
  return items.every((it) => {
    if (it.type !== 'folder') return true;
    const wit = it as WithOC<CollectionItem>;
    if (wit._oc !== undefined && !authUnchanged(wit._oc, it.auth)) return false;
    return allFolderAuthsUnchanged(it.items);
  });
}

/**
 * Root-level structural staleness check (GH #278). `allItemsHaveOcBag` only sees
 * bag *presence*, so a root-level removal — where every survivor keeps its bag
 * and the store strips nothing (ancestorPath is empty at the root) — slips past
 * it and the cached document re-emits the deleted item. A count reconciliation
 * catches it. The root carries the extension-item asymmetry: sse/mcp/kafka/mqtt
 * requests live in `c.items` internally but under
 * `extensions['x-restura-sse'|'-mcp'|'-kafka'|'-mqtt'|'-socketio']` in `c._oc`
 * (NOT `c._oc.items`), so the two partitions reconcile separately.
 * Count is sufficient: adds are already caught by `allItemsHaveOcBag` (the new
 * item lacks a bag); only a removal strictly drops the count. Nested removals
 * are handled by ancestor `_oc`-stripping in the store, so this stays root-only.
 */
const EXTENSION_REQUEST_TYPES = new Set(['sse', 'mcp', 'kafka', 'mqtt', 'socketio']);

function rootStructureUnchanged(c: WithOC<Collection>): boolean {
  const cached = c._oc as OpenCollection | undefined;
  if (!cached) return true;
  const live = c.items ?? [];
  const liveStream = live.filter(
    (it) => it.type === 'request' && EXTENSION_REQUEST_TYPES.has(it.request?.type ?? '')
  ).length;
  const liveNonStream = live.length - liveStream;
  const ext = (cached.extensions ?? {}) as Record<string, unknown>;
  // Only root-level entries count; folder-nested ones (non-empty `folderPath`,
  // #866) live under a folder internally. An entry whose folder could not be
  // resolved on import lands at the root, so it miscounts as "changed" — which
  // only costs byte-stability (a rebuild), never correctness.
  const rootEntries = (list: unknown): number =>
    Array.isArray(list)
      ? list.filter((e) => {
          const p = (e as { folderPath?: unknown } | null)?.folderPath;
          return !Array.isArray(p) || p.length === 0;
        }).length
      : 0;
  const cachedStream =
    rootEntries(ext['x-restura-sse']) +
    rootEntries(ext['x-restura-mcp']) +
    rootEntries(ext[KAFKA_EXTENSION_KEY]) +
    rootEntries(ext[MQTT_EXTENSION_KEY]) +
    rootEntries(ext[SOCKETIO_EXTENSION_KEY]);
  return liveNonStream === (cached.items ?? []).length && liveStream === cachedStream;
}

function variablesFromInternal(variables: Array<KeyValue & { private?: boolean }> | undefined) {
  return (variables ?? [])
    .filter((v) => !v.private)
    .map((v) => {
      const common: { description?: string; disabled?: boolean } = {};
      if (v.description) common.description = v.description;
      if (v.enabled === false) common.disabled = true;
      return v.secret
        ? { secret: true as const, name: v.key, ...common }
        : { name: v.key, value: v.value, ...common };
    });
}

function rootMetadataUnchanged(c: WithOC<Collection>): boolean {
  const cached = c._oc as OpenCollection | undefined;
  if (!cached) return true;
  const cachedVariables = (cached.config?.environments?.[0]?.variables ?? []).map(
    ocVariableToKeyValue
  );
  const cachedContract = (cached.extensions as Record<string, unknown> | undefined)?.[
    'x-restura-contract'
  ];
  return (
    cached.info.name === c.name &&
    (cached.info.summary ?? (typeof cached.docs === 'string' ? cached.docs : '')) ===
      (c.description ?? '') &&
    JSON.stringify(comparableVariables(cachedVariables)) ===
      JSON.stringify(comparableVariables(c.variables ?? [])) &&
    JSON.stringify(cachedContract) === JSON.stringify(c.contractSpec)
  );
}

function applyRootMetadata(oc: OpenCollection, c: Collection): void {
  oc.info = { ...oc.info, name: c.name };
  if (c.description) oc.info.summary = c.description;
  else delete oc.info.summary;
  if (typeof oc.docs === 'string') delete oc.docs;

  const variables = variablesFromInternal(c.variables);
  const config = oc.config ? { ...oc.config } : {};
  const environments = [...(config.environments ?? [])];
  if (variables.length > 0) {
    const first = environments[0] ?? { name: 'default' };
    environments[0] = { ...first, variables };
  } else if (environments[0]) {
    const first = { ...environments[0] };
    delete first.variables;
    environments[0] = first;
  }
  if (environments.length > 0) {
    config.environments = environments;
    oc.config = config;
  } else if (Object.keys(config).length > 0) {
    oc.config = config;
  } else {
    delete oc.config;
  }
}

function comparableVariables(variables: KeyValue[]) {
  return variables.map(({ key, value, enabled, description, secret }) => ({
    key,
    value,
    enabled,
    ...(description ? { description } : {}),
    ...(secret ? { secret: true } : {}),
  }));
}

/**
 * Export-time staleness check for collection/folder scripts, mirroring
 * {@link authUnchanged}. Converts the cached `_oc` bag's `request.scripts`
 * through the SAME import grouping (`groupScripts`) and compares the resulting
 * pre/test strings against the current internal fields. Equal → cached bytes
 * are still true (emit verbatim); different → scripts were edited in-app and
 * the cached doc must be rebuilt. `groupScripts` is side-effect-free, so this
 * never touches the import-time unrecognized-script counters.
 */
function scriptsUnchanged(
  cachedNode: unknown,
  preRequest: string | undefined,
  test: string | undefined
): boolean {
  const cachedRequest = (cachedNode as { request?: unknown } | undefined)?.request;
  const cached = groupScripts((cachedRequest as { scripts?: unknown } | undefined)?.scripts);
  return (cached.preRequest ?? '') === (preRequest ?? '') && (cached.test ?? '') === (test ?? '');
}

/**
 * Export-time staleness check for folder variables (OC folder
 * `request.variables`), through the same import conversion. Private variables
 * never export, so they are left out of the comparison.
 */
function folderVariablesUnchanged(
  cachedNode: unknown,
  variables: CollectionItem['variables']
): boolean {
  const cachedRequest = (cachedNode as { request?: unknown } | undefined)?.request;
  const cached = (cachedRequest as { variables?: unknown } | undefined)?.variables;
  const cachedVariables = Array.isArray(cached) ? cached.map(ocVariableToKeyValue) : [];
  return (
    JSON.stringify(comparableVariables(cachedVariables)) ===
    JSON.stringify(comparableVariables((variables ?? []).filter((v) => !v.private)))
  );
}

/** Recursively true when every folder's variables still match its cached bag. */
function allFolderVariablesUnchanged(items: CollectionItem[] | undefined): boolean {
  if (!items) return true;
  return items.every((it) => {
    if (it.type !== 'folder') return true;
    const wit = it as WithOC<CollectionItem>;
    if (wit._oc !== undefined && !folderVariablesUnchanged(wit._oc, it.variables)) return false;
    return allFolderVariablesUnchanged(it.items);
  });
}

/** Recursively true when every folder's scripts still match its cached bag. */
function allFolderScriptsUnchanged(items: CollectionItem[] | undefined): boolean {
  if (!items) return true;
  return items.every((it) => {
    if (it.type !== 'folder') return true;
    const wit = it as WithOC<CollectionItem>;
    if (wit._oc !== undefined && !scriptsUnchanged(wit._oc, it.preRequestScript, it.testScript)) {
      return false;
    }
    return allFolderScriptsUnchanged(it.items);
  });
}

function methodTypeFromInternal(t: GrpcMethodType): string {
  switch (t) {
    case 'server-streaming':
      return 'serverStreaming';
    case 'client-streaming':
      return 'clientStreaming';
    case 'bidirectional-streaming':
      return 'bidirectional';
    case 'unary':
    default:
      return 'unary';
  }
}
