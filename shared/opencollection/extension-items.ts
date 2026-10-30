import type { CollectionItem, McpRequest, SseRequest } from '../types';
import { authFromInternal } from './auth-from-internal';
import { kafkaToOC, mqttToOC } from './broker-items';
import { kvFromInternal } from './key-value';
import { mcpStdioToOC } from './mcp-stdio-extension';
import { socketIoToOC } from './stream-items';

/**
 * Export-side helpers for request kinds that OpenCollection has no item type
 * for (SSE, MCP, Kafka, MQTT, Socket.IO). They are emitted into root `extensions`
 * lists (`x-restura-sse` / `-mcp` / `-kafka` / `-mqtt` / `-socketio`) with a `folderPath`; see
 * `from-internal.ts` (caller) and `to-internal.ts` (`placeExtensionItems`).
 */

type WithOC<T> = T & { _oc?: unknown };

/** Root-extension lists for request kinds OpenCollection has no item type for. */
export interface ExtensionLists {
  sse: unknown[];
  mcp: unknown[];
  kafka: unknown[];
  mqtt: unknown[];
  socketio: unknown[];
}

/**
 * Route an SSE / MCP / Kafka / MQTT request into its root extension list.
 * OpenCollection has no native item for these, so these live in root `extensions` regardless of
 * where they sit in the tree; `folderPath` (ancestor folder names) records the
 * folder so `to-internal` can re-nest it (#866). The path is always stamped
 * fresh — a cached `_oc` entry keeps its bytes but never a stale location.
 * Returns false for any other request type.
 */
export function pushStreamItem(
  it: WithOC<CollectionItem>,
  folderPath: string[],
  lists: ExtensionLists
): boolean {
  const r = it.request;
  const entry =
    r?.type === 'sse'
      ? (it._oc ?? sseToOC(it.name, r))
      : r?.type === 'mcp'
        ? (it._oc ?? mcpToOC(it.name, r))
        : r?.type === 'kafka'
          ? (it._oc ?? kafkaToOC(it.name, r))
          : r?.type === 'mqtt'
            ? (it._oc ?? mqttToOC(it.name, r))
            : r?.type === 'socketio'
              ? (it._oc ?? socketIoToOC(it.name, r))
              : undefined;
  if (!r || entry === undefined) return false;
  lists[r.type as keyof ExtensionLists].push(withFolderPath(entry, folderPath));
  return true;
}

export function nonEmpty(list: unknown[]): unknown[] | undefined {
  return list.length > 0 ? list : undefined;
}

function withFolderPath(entry: unknown, folderPath: string[]): unknown {
  const out = { ...(entry as Record<string, unknown>) };
  if (folderPath.length > 0) out.folderPath = folderPath;
  else delete out.folderPath;
  return out;
}

/**
 * Collect the SSE / MCP / Kafka / MQTT descendants of a folder that is being emitted verbatim
 * from its `_oc` bag. The bag is an OC folder, which cannot hold them, so they
 * must still reach the root extension lists.
 */
export function collectNestedStreamItems(
  items: CollectionItem[] | undefined,
  folderPath: string[],
  lists: ExtensionLists
): void {
  for (const child of items ?? []) {
    if (child.type === 'folder') {
      collectNestedStreamItems(child.items, [...folderPath, child.name], lists);
      continue;
    }
    pushStreamItem(child as WithOC<CollectionItem>, folderPath, lists);
  }
}

/**
 * Every `SseRequest` field is carried (#863); scripts use the same
 * `runtime.scripts` container as HTTP/gRPC items. The fidelity harness
 * (`fidelity-roundtrip.test.ts`) fails type-check when a field is added to
 * the type without being classified there.
 */
function sseToOC(name: string, r: SseRequest): unknown {
  const sse: Record<string, unknown> = { url: r.url };
  if (r.headers?.length) {
    sse.headers = r.headers.map(kvFromInternal);
  }
  if (r.params?.length) {
    sse.params = r.params.map(kvFromInternal);
  }
  if (r.eventFilter?.length) sse.eventFilter = r.eventFilter;
  if (typeof r.reconnectOnResume === 'boolean') sse.reconnectOnResume = r.reconnectOnResume;
  if (typeof r.autoReconnect === 'boolean') sse.autoReconnect = r.autoReconnect;
  const auth = authFromInternal(r.auth);
  if (auth) sse.auth = auth;
  const out: Record<string, unknown> = { info: { type: 'sse', name }, sse };
  const runtime = runtimeFromInternal(r.preRequestScript, r.testScript);
  if (runtime) out.runtime = runtime;
  return out;
}

/** Every `McpRequest` field is carried (#863), incl. the saved operation. */
function mcpToOC(name: string, r: McpRequest): unknown {
  const mcp: Record<string, unknown> = { url: r.url, transport: r.transport };
  if (r.stdio) mcp.stdio = mcpStdioToOC(r.stdio);
  if (r.headers?.length) {
    mcp.headers = r.headers.map(kvFromInternal);
  }
  if (r.defaultMethod !== undefined) mcp.defaultMethod = r.defaultMethod;
  if (r.defaultParams !== undefined) mcp.defaultParams = r.defaultParams;
  const auth = authFromInternal(r.auth);
  if (auth) mcp.auth = auth;
  const out: Record<string, unknown> = { info: { type: 'mcp', name }, mcp };
  const runtime = runtimeFromInternal(r.preRequestScript, r.testScript);
  if (runtime) out.runtime = runtime;
  return out;
}

/**
 * Build an OpenCollection `Script[]` from the internal preRequestScript /
 * testScript fields. Returns undefined when neither is set so callers can omit
 * the container (request `runtime` or collection/folder `request.scripts`)
 * entirely and keep the YAML compact.
 */
export function buildScripts(
  preRequest?: string,
  test?: string
): Array<{ type: string; code: string }> | undefined {
  const scripts: Array<{ type: string; code: string }> = [];
  if (preRequest && preRequest.trim().length > 0) {
    scripts.push({ type: 'before-request', code: preRequest });
  }
  if (test && test.trim().length > 0) {
    scripts.push({ type: 'tests', code: test });
  }
  return scripts.length === 0 ? undefined : scripts;
}

/**
 * Build a request-level `runtime` object with `scripts: Script[]` from the
 * internal preRequestScript / testScript fields. Returns undefined if neither
 * is set, so the caller can omit the `runtime` key entirely.
 */
export function runtimeFromInternal(
  preRequest?: string,
  test?: string
): Record<string, unknown> | undefined {
  const scripts = buildScripts(preRequest, test);
  return scripts ? { scripts } : undefined;
}
