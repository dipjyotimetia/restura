import type { SocketIoRequest, WebSocketRequest } from '../../types';
import { arr, isObj, type Raw } from './common';
import { nonEmpty, type RequestOut } from './export-v3-http';
import {
  AUTH_TYPES,
  defined,
  type ExportContext,
  kvRows,
  restoreBagOnlyAuth,
} from './export-v3-shared';
import { SIO_MAPPED_SETTINGS, WS_MAPPED_SETTINGS } from './parse-v3-streaming';
import type { PostmanSidecar } from './sidecar';

/**
 * Restura WebSocket / Socket.IO collection items → Postman v3
 * `websocket-request` / `socket.io-request` (#1209). The inverse of
 * `parse-v3-streaming.ts`: the import `leftovers` (settings Restura does not
 * model, disabled query rows, event notes, message encodings), saved examples
 * (the v2 `response[]` bag) and
 * bag-only WebSocket auth are restored from the sidecar; Restura-only options
 * are reported as not exported.
 */

function leftovers(sidecar: PostmanSidecar | undefined): Raw {
  return isObj(sidecar?.leftovers) ? sidecar.leftovers : {};
}

function restSettings(left: Raw, mapped: Set<string>): Raw {
  return Object.fromEntries(
    Object.entries(isObj(left.settings) ? left.settings : {}).filter(([k]) => !mapped.has(k))
  );
}

/** Original encoding recorded at import for a message (xml / html / base64 …). */
function keptEncoding(left: Raw, message: string, arg?: number): string | undefined {
  const hit = arr(left.payloadEncodings)
    .filter(isObj)
    .find((e) => e.message === message && (arg === undefined || e.arg === arg));
  return typeof hit?.contentType === 'string' ? hit.contentType : undefined;
}

/**
 * Sidecar `response[]` (v2 saved-response shape, written by `keepExamples` /
 * `exampleToV2`) → v3 `websocket-example` / `socket.io-example`s. The frames
 * were packed as JSON into the v2 `body`; a redacted (blanked) or non-JSON
 * body restores an empty session.
 */
function restoreExamples(
  sidecar: PostmanSidecar | undefined,
  kind: 'websocket-example' | 'socket.io-example'
): Raw[] | undefined {
  const out = arr(sidecar?.response)
    .filter(isObj)
    .map((ex, i) => {
      const req = isObj(ex.originalRequest) ? ex.originalRequest : {};
      const headers = arr(req.header)
        .filter(isObj)
        .filter((h) => typeof h.key === 'string')
        .map((h) => defined({ key: h.key, value: typeof h.value === 'string' ? h.value : '' }));
      let response: Raw = {};
      try {
        const parsed = JSON.parse(typeof ex.body === 'string' ? ex.body : '') as unknown;
        if (isObj(parsed)) response = parsed;
      } catch {
        // Blanked by redaction (or not JSON): an empty session.
      }
      const request = defined({
        url: typeof req.url === 'string' && req.url !== '' ? req.url : undefined,
        headers: headers.length > 0 ? headers : undefined,
      });
      return defined({
        name: typeof ex.name === 'string' && ex.name !== '' ? ex.name : `Example ${i + 1}`,
        $kind: kind,
        request: Object.keys(request).length > 0 ? request : undefined,
        response,
      });
    });
  return out.length > 0 ? out : undefined;
}

export function exportWebSocket(
  req: WebSocketRequest,
  name: string,
  sidecar: PostmanSidecar | undefined,
  ctx: ExportContext
): RequestOut {
  const left = leftovers(sidecar);
  const o = req.options ?? {};
  const extras = [
    req.protocols.length > 0 ? 'subprotocols' : '',
    o.heartbeatInterval ? 'heartbeat' : '',
    o.perMessageDeflate === false ? 'permessage-deflate off' : '',
    req.frameAssertion ? 'frame assertion' : '',
    req.templates.length > 0 &&
    req.message.body !== '' &&
    !req.templates.some((t) => t.body === req.message.body && t.format === req.message.format)
      ? 'composer draft'
      : '',
  ].filter(Boolean);
  if (extras.length > 0) ctx.report.dropped('websocket-extras', name, extras.join(', '));
  const saved =
    req.templates.length > 0
      ? req.templates
      : req.message.body !== ''
        ? [{ name: 'Message', ...req.message }]
        : [];
  const messages = saved.map((t) =>
    defined({
      name: t.name || 'Message',
      $kind: 'websocket-message',
      content: t.body,
      contentType: keptEncoding(left, t.name) ?? t.format,
    })
  );
  const retryCount = o.autoReconnect === false ? 0 : o.maxReconnectAttempts;
  const settings = defined({
    ...restSettings(left, WS_MAPPED_SETTINGS),
    retryCount,
    retryDelay: o.reconnectDelay,
  });
  return {
    item: defined({
      name,
      $kind: 'websocket-request',
      description: req.description || undefined,
      url: req.url,
      headers: nonEmpty(kvRows(req.headers, name, ctx)),
      queryParams: nonEmpty(arr(left.queryParams).filter(isObj)),
      auth: restoreBagOnlyAuth(sidecar, AUTH_TYPES.websocket, name, ctx),
      settings: Object.keys(settings).length > 0 ? settings : undefined,
      messages: nonEmpty(messages),
      examples: restoreExamples(sidecar, 'websocket-example'),
    }),
  };
}

/** Composer args text → v3 message args (inverse of the import's `argsText`). */
function argsFromText(text: string, left: Raw, message: string): Raw[] {
  const arg = (value: unknown, i: number): Raw => {
    const kept = keptEncoding(left, message, i);
    if (typeof value === 'string') return { content: value, contentType: kept ?? 'text' };
    return { content: JSON.stringify(value), contentType: 'json' };
  };
  if (text.trim() === '') return [{ content: '', contentType: 'text' }];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.map(arg) : [arg(parsed, 0)];
  } catch {
    // `{{var}}` placeholders / hand-typed text: one argument, as typed.
    return [{ content: text, contentType: 'json' }];
  }
}

export function exportSocketIo(
  req: SocketIoRequest,
  name: string,
  sidecar: PostmanSidecar | undefined,
  ctx: ExportContext
): RequestOut {
  const left = leftovers(sidecar);
  const o = req.options ?? {};
  const extras = [
    req.namespace && req.namespace !== '/' ? 'namespace' : '',
    req.handshakeAuth.length > 0 ? 'handshake auth' : '',
    req.transports.length !== 2 ? 'transports' : '',
    o.forceNew ? 'forceNew' : '',
  ].filter(Boolean);
  if (extras.length > 0) ctx.report.dropped('socketio-extras', name, extras.join(', '));
  const saved =
    req.templates.length > 0
      ? req.templates
      : req.emit.eventName !== '' && req.emit.args !== ''
        ? [{ name: 'Emit', ...req.emit }]
        : [];
  const messages = saved.map((t) =>
    defined({
      name: t.name || 'Emit',
      $kind: 'socket.io-message',
      eventName: t.eventName,
      acknowledgement: t.ack ? true : undefined,
      args: argsFromText(t.args, left, t.name),
    })
  );
  const keptEvents = arr(left.events).filter(isObj);
  const events = req.subscribedEvents.map(
    (eventName) => keptEvents.find((e) => e.name === eventName) ?? { name: eventName }
  );
  const retryCount = o.autoReconnect === false ? 0 : o.reconnectionAttempts;
  const settings = defined({
    ...restSettings(left, SIO_MAPPED_SETTINGS),
    path: req.path && req.path !== '/socket.io' ? req.path : undefined,
    handshakeTimeout: o.timeout,
    retryCount,
    retryDelay: o.reconnectionDelay,
  });
  return {
    item: defined({
      name,
      $kind: 'socket.io-request',
      description: req.description || undefined,
      url: req.url,
      headers: nonEmpty(kvRows(req.headers, name, ctx)),
      queryParams: nonEmpty(kvRows(req.query, name, ctx)),
      events: nonEmpty(events),
      settings: Object.keys(settings).length > 0 ? settings : undefined,
      messages: nonEmpty(messages),
      examples: restoreExamples(sidecar, 'socket.io-example'),
    }),
  };
}
