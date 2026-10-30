import { v4 as uuid } from 'uuid';
import type {
  CollectionItem,
  SocketIoPresetEmit,
  SocketIoPresetOptions,
  SocketIoRequest,
  WebSocketPresetFormat,
  WebSocketPresetMessage,
  WebSocketPresetOptions,
  WebSocketRequest,
} from '../../types';
import { arr, description, isObj, type ParseContext, type Raw, str } from './common';
import { keepBrokerAuth } from './parse-v3-protocols';
import { keepExamples, rows, scrub } from './parse-v3-shared';
import { PostmanReportBuilder } from './report';
import { attachPostmanSidecar, getPostmanSidecar, type PostmanSidecar } from './sidecar';

/**
 * Postman v3 `websocket-request` / `socket.io-request` → Restura WebSocket /
 * Socket.IO collection items (#1209). The inverse is `export-v3-streaming.ts`.
 *
 * Restura models the URL, handshake headers / query, saved messages and the
 * reconnect knobs. Everything else (handshake timeout, max payload, strictSSL,
 * Socket.IO client version, event descriptions, message encodings
 * Restura cannot send) is kept scrubbed in the sidecar's `leftovers` and
 * reported; export restores it. Postman WebSocket auth has no Restura slot:
 * it is kept bag-only (like broker auth) and reported as unsupported.
 */

const WS_FORMATS: Record<string, WebSocketPresetFormat> = {
  text: 'text',
  json: 'json',
  hex: 'hex',
};

/** The v3 settings Restura maps; the rest go to `leftovers.settings`. */
export const WS_MAPPED_SETTINGS = new Set(['retryCount', 'retryDelay']);
export const SIO_MAPPED_SETTINGS = new Set([
  'path',
  'handshakeTimeout',
  'retryCount',
  'retryDelay',
]);

function keepLeftovers(
  leftovers: Raw,
  name: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): void {
  const keys = Object.keys(leftovers);
  if (keys.length === 0) return;
  sidecar.leftovers = scrub(leftovers);
  ctx.report.unmodelled('connection-leftovers', name, keys.join(', '));
}

function unmappedSettings(settings: Raw, mapped: Set<string>): Raw | undefined {
  const rest = Object.fromEntries(Object.entries(settings).filter(([k]) => !mapped.has(k)));
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * Enabled `queryParams` that the URL does not already carry are appended to
 * it (the Restura connection has no separate query table); disabled rows are
 * kept in `leftovers`.
 */
function urlWithQuery(url: string, queryParams: unknown, leftovers: Raw): string {
  const params = arr(queryParams).filter(isObj);
  const disabled = params.filter((p) => p.disabled === true);
  if (disabled.length > 0) leftovers.queryParams = disabled;
  const q = url.indexOf('?');
  const existing = new URLSearchParams(q === -1 ? '' : url.slice(q + 1));
  const extra = params
    .filter((p) => p.disabled !== true && str(p.key) !== '' && !existing.has(str(p.key)))
    .map((p) => `${str(p.key)}=${str(p.value)}`);
  if (extra.length === 0) return url;
  return `${url}${q === -1 ? '?' : url.endsWith('?') || url.endsWith('&') ? '' : '&'}${extra.join('&')}`;
}

function retryOptions(settings: Raw) {
  const count = typeof settings.retryCount === 'number' ? settings.retryCount : undefined;
  const delay = typeof settings.retryDelay === 'number' ? settings.retryDelay : undefined;
  return { count, delay };
}

const nonNeg = (n: number | undefined) =>
  n !== undefined && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined;

export function convertWebSocket(
  raw: Raw,
  name: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): { req: WebSocketRequest; inherits: false } {
  const settings = isObj(raw.settings) ? raw.settings : {};
  const leftovers: Raw = {};
  keepBrokerAuth(raw, name, sidecar, ctx);
  const url = urlWithQuery(str(raw.url), raw.queryParams, leftovers);
  const encodings: Raw[] = [];
  const templates: WebSocketPresetMessage[] = arr(raw.messages)
    .filter(isObj)
    .map((m, i) => {
      const msgName = str(m.name) || `Message ${i + 1}`;
      const type = str(m.contentType);
      const format = WS_FORMATS[type];
      // xml / html / base64 are sent as their text: keep the original encoding.
      if (type !== '' && format === undefined)
        encodings.push({ message: msgName, contentType: type });
      return { name: msgName, body: str(m.content), format: format ?? 'text' };
    });
  if (encodings.length > 0) leftovers.payloadEncodings = encodings;
  const rest = unmappedSettings(settings, WS_MAPPED_SETTINGS);
  if (rest) leftovers.settings = rest;
  // Examples go to the saved-response bag (v2 shape) like every other kind's,
  // so the export redactor blanks and counts their bodies and headers.
  keepExamples(raw, name, sidecar, ctx);
  if (settings.strictSSL === false) {
    ctx.report.securityDowngrade('strictSSL', name, 'TLS certificate verification is off');
  }
  keepLeftovers(leftovers, name, sidecar, ctx);
  const retry = retryOptions(settings);
  const first = templates[0];
  const req: WebSocketRequest = {
    id: uuid(),
    name,
    type: 'websocket',
    url,
    protocols: [],
    headers: rows(raw.headers),
    message: first ? { body: first.body, format: first.format } : { body: '', format: 'text' },
    templates,
  };
  const options: WebSocketPresetOptions = {};
  const count = nonNeg(retry.count);
  const delay = nonNeg(retry.delay);
  if (count !== undefined) {
    options.autoReconnect = count > 0;
    options.maxReconnectAttempts = count;
  }
  if (delay !== undefined) options.reconnectDelay = delay;
  if (Object.keys(options).length > 0) req.options = options;
  const desc = description(raw.description);
  if (desc) req.description = desc;
  return { req, inherits: false };
}

/**
 * v3 Socket.IO message args → the composer's raw JSON text: one arg is the
 * value itself, several are a JSON array. Text args become JSON strings; JSON
 * args are used as written (a single array arg is wrapped so it stays ONE
 * argument). Hex / base64 args are kept as text and their encoding recorded.
 */
function argsText(args: Raw[], msgName: string, encodings: Raw[]): string {
  const parts = args.map((a, i) => {
    const type = str(a.contentType);
    const content = str(a.content);
    if (type === 'json') return content;
    if (type !== '' && type !== 'text') {
      encodings.push({ message: msgName, arg: i, contentType: type });
    }
    return JSON.stringify(content);
  });
  if (parts.length === 0) return '';
  if (parts.length > 1) return `[${parts.join(', ')}]`;
  const only = parts[0] ?? '';
  return only.trimStart().startsWith('[') ? `[${only}]` : only;
}

export function convertSocketIo(
  raw: Raw,
  name: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): { req: SocketIoRequest; inherits: false } {
  const settings = isObj(raw.settings) ? raw.settings : {};
  const leftovers: Raw = {};
  const encodings: Raw[] = [];
  const templates: SocketIoPresetEmit[] = arr(raw.messages)
    .filter(isObj)
    .map((m, i) => {
      const msgName = str(m.name) || `Emit ${i + 1}`;
      return {
        name: msgName,
        eventName: str(m.eventName),
        args: argsText(arr(m.args).filter(isObj), msgName, encodings),
        ack: m.acknowledgement === true,
      };
    });
  if (encodings.length > 0) leftovers.payloadEncodings = encodings;
  const events = arr(raw.events).filter(isObj);
  // Restura subscribes to a flat list of names: descriptions and
  // "don't subscribe on connect" flags are kept for the export.
  if (events.some((e) => e.description !== undefined || e.subscribeOnConnect !== undefined)) {
    leftovers.events = events;
  }
  const rest = unmappedSettings(settings, SIO_MAPPED_SETTINGS);
  if (rest) leftovers.settings = rest;
  // Examples go to the saved-response bag (v2 shape) like every other kind's,
  // so the export redactor blanks and counts their bodies and headers.
  keepExamples(raw, name, sidecar, ctx);
  if (settings.strictSSL === false) {
    ctx.report.securityDowngrade('strictSSL', name, 'TLS certificate verification is off');
  }
  keepLeftovers(leftovers, name, sidecar, ctx);
  const retry = retryOptions(settings);
  const timeout = nonNeg(
    typeof settings.handshakeTimeout === 'number' ? settings.handshakeTimeout : undefined
  );
  const first = templates[0];
  const req: SocketIoRequest = {
    id: uuid(),
    name,
    type: 'socketio',
    url: str(raw.url),
    namespace: '/',
    path: str(settings.path) || '/socket.io',
    handshakeAuth: [],
    query: rows(raw.queryParams),
    headers: rows(raw.headers),
    transports: ['websocket', 'polling'],
    subscribedEvents: events.map((e) => str(e.name)).filter((n) => n !== ''),
    emit: first
      ? { eventName: first.eventName, args: first.args, ack: first.ack }
      : { eventName: 'message', args: '', ack: false },
    templates,
  };
  const options: SocketIoPresetOptions = {};
  const count = nonNeg(retry.count);
  const delay = nonNeg(retry.delay);
  if (count !== undefined) {
    options.autoReconnect = count > 0;
    options.reconnectionAttempts = count;
  }
  if (delay !== undefined) options.reconnectionDelay = delay;
  if (timeout !== undefined) options.timeout = timeout;
  if (Object.keys(options).length > 0) req.options = options;
  const desc = description(raw.description);
  if (desc) req.description = desc;
  return { req, inherits: false };
}

// ── back-compat: pre-#1209 placeholder folders ──────────────────────────────

const PLACEHOLDER_SUFFIX: Record<string, string> = {
  'websocket-request': ' (WebSocket)',
  'socket.io-request': ' (Socket.IO)',
};

/**
 * Before #1209 a Postman v3 WebSocket / Socket.IO item imported as an EMPTY
 * placeholder folder holding the scrubbed raw item in `_postman.item` (auth
 * kept bag-only next to it). Rebuild the native item from that sidecar; any
 * other node is returned unchanged (same reference). Idempotent.
 */
export function upgradeStreamPlaceholder(item: CollectionItem): CollectionItem {
  if (!isObj(item) || item.type !== 'folder' || (item.items?.length ?? 0) > 0) return item;
  const old = getPostmanSidecar(item);
  const raw = old?.item;
  if (!isObj(raw)) return item;
  const kind = str(raw.$kind);
  const suffix = PLACEHOLDER_SUFFIX[kind];
  if (!suffix) return item;
  const label = str(item.name);
  const name =
    str(raw.name).trim() ||
    (label.endsWith(suffix) ? label.slice(0, -suffix.length) : label).trim() ||
    `Untitled ${suffix.trim().slice(1, -1)}`;
  const sidecar: PostmanSidecar = {};
  const ctx: ParseContext = { report: new PostmanReportBuilder(), transformScript: (s) => s };
  const { req } =
    kind === 'websocket-request'
      ? convertWebSocket(raw, name, sidecar, ctx)
      : convertSocketIo(raw, name, sidecar, ctx);
  // The raw item was scrubbed of `auth` at import; its bag-only copy stays.
  if (old?.auth !== undefined) {
    sidecar.auth = old.auth;
    if (old.authBagOnly) sidecar.authBagOnly = true;
  }
  if (old?.noauth) sidecar.noauth = true;
  return attachPostmanSidecar<CollectionItem>(
    { id: item.id, name, type: 'request', request: req },
    sidecar
  );
}

/** {@link upgradeStreamPlaceholder} over a tree; unchanged subtrees keep their references. */
export function upgradeStreamPlaceholders(items: CollectionItem[]): CollectionItem[] {
  let changed = false;
  const next = items.map((item) => {
    const upgraded = upgradeStreamPlaceholder(item);
    if (upgraded !== item) {
      changed = true;
      return upgraded;
    }
    if (!isObj(item) || !Array.isArray(item.items) || item.items.length === 0) return item;
    const children = upgradeStreamPlaceholders(item.items);
    if (children === item.items) return item;
    changed = true;
    return { ...item, items: children };
  });
  return changed ? next : items;
}
