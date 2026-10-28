import { v4 as uuid } from 'uuid';
import type {
  CollectionItem,
  SocketIoPresetEmit,
  SocketIoPresetOptions,
  SocketIoPresetTransport,
  SocketIoRequest,
  WebSocketPresetFormat,
  WebSocketPresetOptions,
  WebSocketRequest,
} from '../types';
import { kvFromInternal, kvToInternal } from './key-value';
import { createSamePathIndexer, type PathKeyedEntry } from './path-keyed-extension';

/**
 * OpenCollection mapping for saved WebSocket / Socket.IO connections (#1209).
 *
 * WebSocket — OpenCollection HAS a native `websocket` item (url, headers,
 * message or message variants), so a WebSocket item is emitted there, where
 * other OC tools can read it. The Restura-only fields (subprotocols, composer
 * draft when saved messages exist, reconnect / heartbeat options, frame
 * assertion) ride in the path-keyed root `extensions['x-restura-websocket']`
 * (matched by name path, like `x-restura-http`). Imported items keep their
 * verbatim `_oc` bag, so OC-only data Restura does not model (e.g. a
 * handshake `auth` block) survives an unedited round trip.
 *
 * Socket.IO — no OC item type: entries ride in root
 * `extensions['x-restura-socketio']` with a `folderPath`, exactly like the
 * Kafka / MQTT presets (`broker-items.ts`). Typed and lossless, so imported
 * entries keep no `_oc` bag.
 */

export const WEBSOCKET_EXTENSION_KEY = 'x-restura-websocket';
export const SOCKETIO_EXTENSION_KEY = 'x-restura-socketio';

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const optBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const optNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined;
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
/**
 * OC rows → KeyValue rows. Also accepts the `{ key: value }` map shape that
 * hand-written `x-restura-socketio` entries used before #1209.
 */
const rows = (v: unknown) => {
  if (Array.isArray(v)) return v.map(kvToInternal);
  if (!v || typeof v !== 'object') return [];
  return Object.entries(v as Obj)
    .filter((e): e is [string, string | number | boolean] =>
      ['string', 'number', 'boolean'].includes(typeof e[1])
    )
    .map(([name, value]) => kvToInternal({ name, value: String(value) }));
};

/** `T` with every key optional and `undefined` removed (sound under exactOptionalPropertyTypes). */
type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/** Copy only the defined keys of `src` — keeps exported YAML free of `undefined`s. */
function defined<T extends Obj>(src: T): Defined<T> {
  return Object.fromEntries(Object.entries(src).filter(([, v]) => v !== undefined)) as Defined<T>;
}

function definedOrUndefined<T extends Obj>(src: T): Defined<T> | undefined {
  const out = defined(src);
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const WS_FORMATS: readonly WebSocketPresetFormat[] = ['text', 'json', 'hex'];

/** Restura format → OC message `type` (`hex` is sent as bytes: `binary`). */
function ocMessageType(format: WebSocketPresetFormat): string {
  return format === 'hex' ? 'binary' : format;
}

/** OC message `type` → Restura format (`xml` is sent as text). */
function formatFromOC(type: unknown): WebSocketPresetFormat {
  if (type === 'binary') return 'hex';
  return type === 'json' ? 'json' : 'text';
}

function ocMessage(m: { body: string; format: WebSocketPresetFormat }): Obj {
  return { type: ocMessageType(m.format), data: m.body };
}

function messageFromOC(v: unknown): { body: string; format: WebSocketPresetFormat } {
  const m = obj(v);
  return { body: str(m.data), format: formatFromOC(m.type) };
}

const isDefaultDraft = (m: { body: string; format: WebSocketPresetFormat }) =>
  m.body === '' && m.format === 'text';

/** Native OC `websocket` item for a WebSocket connection. */
export function webSocketToOC(name: string, r: WebSocketRequest): unknown {
  const websocket: Obj = { url: r.url };
  if (r.headers.length > 0) websocket.headers = r.headers.map(kvFromInternal);
  if (r.templates.length > 0) {
    websocket.message = r.templates.map((t) => ({ title: t.name, message: ocMessage(t) }));
  } else if (!isDefaultDraft(r.message)) {
    websocket.message = ocMessage(r.message);
  }
  return {
    info: defined({ type: 'websocket', name, description: r.description || undefined }),
    websocket,
  };
}

/** Native OC `websocket` item → WebSocket connection (Restura-only extras applied later). */
export function webSocketFromOC(it: Obj): WebSocketRequest {
  const info = obj(it.info);
  const ws = obj(it.websocket);
  const req: WebSocketRequest = {
    id: uuid(),
    name: str(info.name, 'WebSocket'),
    type: 'websocket',
    url: str(ws.url),
    protocols: [],
    headers: rows(ws.headers),
    message: { body: '', format: 'text' },
    templates: [],
  };
  if (Array.isArray(ws.message)) {
    const variants = ws.message.map(obj);
    req.templates = variants.map((v, i) => ({
      name: str(v.title, `Message ${i + 1}`),
      ...messageFromOC(v.message),
    }));
    const selected = variants.find((v) => v.selected === true);
    if (selected) req.message = messageFromOC(selected.message);
  } else if (ws.message && typeof ws.message === 'object') {
    req.message = messageFromOC(ws.message);
  }
  const description =
    typeof info.description === 'string' ? info.description : str(obj(info.description).content);
  if (description) req.description = description;
  return req;
}

interface WebSocketExtensionEntry extends PathKeyedEntry {
  protocols?: string[];
  message?: { body: string; format: WebSocketPresetFormat };
  options?: WebSocketPresetOptions;
  frameAssertion?: { enabled: boolean; script: string };
}

function walkWebSockets(
  items: CollectionItem[] | undefined,
  parents: string[],
  visit: (req: WebSocketRequest, path: string[]) => void
): void {
  for (const it of items ?? []) {
    if (it.type === 'folder') {
      walkWebSockets(it.items, [...parents, it.name], visit);
      continue;
    }
    if (it.request?.type === 'websocket') visit(it.request, [...parents, it.name]);
  }
}

function wsOptions(o: WebSocketPresetOptions | undefined): WebSocketPresetOptions | undefined {
  if (!o) return undefined;
  return definedOrUndefined({
    autoReconnect: o.autoReconnect,
    maxReconnectAttempts: o.maxReconnectAttempts,
    reconnectDelay: o.reconnectDelay,
    heartbeatInterval: o.heartbeatInterval,
    heartbeatMessage: o.heartbeatMessage,
    perMessageDeflate: o.perMessageDeflate,
  });
}

/** `x-restura-websocket` from the internal tree; undefined when nothing to carry. */
export function buildWebSocketExtension(
  items: CollectionItem[] | undefined
): { requests: WebSocketExtensionEntry[] } | undefined {
  const requests: WebSocketExtensionEntry[] = [];
  const indexOf = createSamePathIndexer();
  walkWebSockets(items, [], (r, path) => {
    const index = indexOf(path);
    const extras = defined({
      protocols: r.protocols.length > 0 ? [...r.protocols] : undefined,
      // The native item holds the draft only when there are no saved messages.
      message:
        r.templates.length > 0 && !isDefaultDraft(r.message)
          ? { body: r.message.body, format: r.message.format }
          : undefined,
      options: wsOptions(r.options),
      frameAssertion: r.frameAssertion
        ? { enabled: r.frameAssertion.enabled, script: r.frameAssertion.script }
        : undefined,
    });
    if (Object.keys(extras).length === 0) return;
    requests.push({ path, ...(index !== undefined ? { index } : {}), ...extras });
  });
  return requests.length > 0 ? { requests } : undefined;
}

/** Re-apply `x-restura-websocket` onto the imported tree (mutates in place). */
export function applyWebSocketExtension(items: CollectionItem[] | undefined, raw: unknown): void {
  const list = obj(raw).requests;
  if (!Array.isArray(list) || list.length === 0) return;
  const byPath = new Map<string, WebSocketRequest[]>();
  walkWebSockets(items, [], (r, path) => {
    const k = JSON.stringify(path);
    byPath.set(k, [...(byPath.get(k) ?? []), r]);
  });
  const claimed = new Set<WebSocketRequest>();
  for (const e of list.map(obj)) {
    const path = e.path;
    if (!Array.isArray(path) || !path.every((p) => typeof p === 'string')) continue;
    const candidates = byPath.get(JSON.stringify(path)) ?? [];
    const target =
      typeof e.index === 'number' ? candidates[e.index] : candidates.find((c) => !claimed.has(c));
    if (!target || claimed.has(target)) continue;
    claimed.add(target);
    const protocols = strArray(e.protocols);
    if (protocols.length > 0) target.protocols = protocols;
    if (e.message && typeof e.message === 'object') {
      const m = obj(e.message);
      target.message = {
        body: str(m.body),
        format: WS_FORMATS.includes(m.format as WebSocketPresetFormat)
          ? (m.format as WebSocketPresetFormat)
          : 'text',
      };
    }
    const o = obj(e.options);
    const options = definedOrUndefined({
      autoReconnect: optBool(o.autoReconnect),
      maxReconnectAttempts: optNum(o.maxReconnectAttempts),
      reconnectDelay: optNum(o.reconnectDelay),
      heartbeatInterval: optNum(o.heartbeatInterval),
      heartbeatMessage: optStr(o.heartbeatMessage),
      perMessageDeflate: optBool(o.perMessageDeflate),
    });
    if (options) target.options = options;
    const fa = obj(e.frameAssertion);
    if (typeof fa.enabled === 'boolean' && typeof fa.script === 'string') {
      target.frameAssertion = { enabled: fa.enabled, script: fa.script };
    }
  }
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------

const TRANSPORTS: readonly SocketIoPresetTransport[] = ['websocket', 'polling'];

function emitFromOC(v: unknown): Omit<SocketIoPresetEmit, 'name'> {
  const e = obj(v);
  return { eventName: str(e.eventName), args: str(e.args), ack: e.ack === true };
}

function sioOptions(o: SocketIoPresetOptions | undefined): SocketIoPresetOptions | undefined {
  if (!o) return undefined;
  return definedOrUndefined({
    autoReconnect: o.autoReconnect,
    reconnectionAttempts: o.reconnectionAttempts,
    reconnectionDelay: o.reconnectionDelay,
    timeout: o.timeout,
    forceNew: o.forceNew,
  });
}

/** `x-restura-socketio` entry. Explicit field picks — never a spread. */
export function socketIoToOC(name: string, r: SocketIoRequest): unknown {
  const socketio = defined({
    url: r.url,
    namespace: r.namespace,
    path: r.path,
    auth: r.handshakeAuth.length > 0 ? r.handshakeAuth.map(kvFromInternal) : undefined,
    query: r.query.length > 0 ? r.query.map(kvFromInternal) : undefined,
    headers: r.headers.length > 0 ? r.headers.map(kvFromInternal) : undefined,
    transports: [...r.transports],
    subscribedEvents: r.subscribedEvents.length > 0 ? [...r.subscribedEvents] : undefined,
    emit: { eventName: r.emit.eventName, args: r.emit.args, ack: r.emit.ack },
    templates:
      r.templates.length > 0
        ? r.templates.map((t) => ({
            name: t.name,
            eventName: t.eventName,
            args: t.args,
            ack: t.ack,
          }))
        : undefined,
    options: sioOptions(r.options),
  });
  return {
    info: defined({ type: 'socketio', name, description: r.description || undefined }),
    socketio,
  };
}

export function socketIoEntryToInternal(entry: Obj): SocketIoRequest {
  const i = obj(entry.info);
  const s = obj(entry.socketio);
  const transports = strArray(s.transports).filter((t): t is SocketIoPresetTransport =>
    TRANSPORTS.includes(t as SocketIoPresetTransport)
  );
  const req: SocketIoRequest = {
    id: uuid(),
    name: str(i.name, 'Socket.IO'),
    type: 'socketio',
    url: str(s.url),
    namespace: str(s.namespace, '/') || '/',
    path: str(s.path, '/socket.io') || '/socket.io',
    handshakeAuth: rows(s.auth),
    query: rows(s.query),
    headers: rows(s.headers),
    transports: transports.length > 0 ? transports : ['websocket', 'polling'],
    subscribedEvents: strArray(s.subscribedEvents),
    emit: emitFromOC(s.emit),
    templates: Array.isArray(s.templates)
      ? s.templates.map((t) => ({ name: str(obj(t).name, 'Emit'), ...emitFromOC(t) }))
      : [],
  };
  const o = obj(s.options);
  const options = definedOrUndefined({
    autoReconnect: optBool(o.autoReconnect),
    reconnectionAttempts: optNum(o.reconnectionAttempts),
    reconnectionDelay: optNum(o.reconnectionDelay),
    timeout: optNum(o.timeout),
    forceNew: optBool(o.forceNew),
  });
  if (options) req.options = options;
  if (typeof i.description === 'string' && i.description) req.description = i.description;
  return req;
}
