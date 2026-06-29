/**
 * Reduce a stream of CDP (`chrome.debugger`) Network-domain events into the
 * normalized `CapturedExchange` model. Stateful but pure (no I/O): the extension
 * service worker feeds events in via `ingest`, fetches response bodies lazily
 * and injects them via `attachResponseBody`, then reads `getExchanges`.
 */
import { classifyProtocol } from './protocol-classifier';
import type { CapturedBody, CapturedExchange, CapturedFrame, CapturedHeader } from './types';

type Params = Record<string, unknown>;

function asParams(params: unknown): Params {
  return params && typeof params === 'object' ? (params as Params) : {};
}

function toHeaders(raw: unknown): CapturedHeader[] {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw as Record<string, unknown>).map(([name, value]) => ({
    name,
    value: String(value),
  }));
}

export class CdpNormalizer {
  // A Map preserves insertion order, so it doubles as the exchange ordering.
  private readonly byId = new Map<string, CapturedExchange>();

  // CDP timestamps are a monotonic clock with an arbitrary origin; wallTime is
  // epoch seconds. The first event carrying both lets us convert any monotonic
  // `timestamp` (e.g. WebSocket/SSE frames) to epoch ms, consistent with
  // `startedAt`. Null until anchored.
  private originOffsetMs: number | null = null;

  ingest(method: string, rawParams: unknown): void {
    const params = asParams(rawParams);
    const requestId = typeof params.requestId === 'string' ? params.requestId : undefined;
    this.anchorTime(params);

    switch (method) {
      case 'Network.requestWillBeSent':
        this.onRequest(requestId, params);
        break;
      case 'Network.responseReceived':
        this.onResponse(requestId, params);
        break;
      case 'Network.webSocketCreated':
        this.onWebSocketCreated(requestId, params);
        break;
      case 'Network.webSocketWillSendHandshakeRequest':
        this.onWebSocketHandshake(requestId, params);
        break;
      case 'Network.webSocketFrameSent':
        this.onFrame(requestId, params, 'sent');
        break;
      case 'Network.webSocketFrameReceived':
        this.onFrame(requestId, params, 'received');
        break;
      case 'Network.eventSourceMessageReceived':
        this.onSseMessage(requestId, params);
        break;
      default:
        break;
    }
  }

  attachResponseBody(requestId: string, body: CapturedBody): void {
    const ex = this.byId.get(requestId);
    if (ex?.response) ex.response.body = body;
  }

  /**
   * Re-seed exchanges from a previously-persisted session so capture can resume
   * after an MV3 service-worker restart. Existing ids are not overwritten.
   */
  seed(exchanges: CapturedExchange[]): void {
    for (const ex of exchanges) {
      if (!this.byId.has(ex.id)) this.byId.set(ex.id, structuredClone(ex));
    }
  }

  getExchanges(): CapturedExchange[] {
    return [...this.byId.values()];
  }

  /** Capture the monotonic→epoch offset from the first event carrying both. */
  private anchorTime(params: Params): void {
    if (this.originOffsetMs !== null) return;
    const { wallTime, timestamp } = params;
    if (typeof wallTime === 'number' && typeof timestamp === 'number') {
      this.originOffsetMs = wallTime * 1000 - timestamp * 1000;
    }
  }

  /** Convert a CDP monotonic `timestamp` (seconds) to epoch ms when anchored. */
  private toEpochMs(timestamp: unknown): number {
    if (typeof timestamp !== 'number') return 0;
    return this.originOffsetMs !== null ? timestamp * 1000 + this.originOffsetMs : timestamp * 1000;
  }

  private ensure(id: string, seed: () => CapturedExchange): CapturedExchange {
    let ex = this.byId.get(id);
    if (!ex) {
      ex = seed();
      this.byId.set(id, ex);
    }
    return ex;
  }

  private onRequest(requestId: string | undefined, params: Params): void {
    if (!requestId) return;
    const req = asParams(params.request);
    const headers = toHeaders(req.headers);
    const url = typeof req.url === 'string' ? req.url : '';
    const method = typeof req.method === 'string' ? req.method : 'GET';
    const bodyText = typeof req.postData === 'string' ? req.postData : undefined;
    const { protocol, graphql } = classifyProtocol({
      url,
      requestHeaders: headers,
      ...(bodyText !== undefined ? { requestBodyText: bodyText } : {}),
    });
    // Seed only the fields preserved across a redirect re-fire (id, start time);
    // the request-derived fields are assigned once below as the single source.
    const ex = this.ensure(requestId, () => ({
      id: requestId,
      protocol,
      method,
      url,
      startedAt: typeof params.wallTime === 'number' ? params.wallTime * 1000 : 0,
      request: { headers: [] },
    }));
    ex.protocol = protocol;
    ex.method = method;
    ex.url = url;
    ex.request.headers = headers;
    if (bodyText !== undefined) ex.request.body = { text: bodyText };
    if (graphql) ex.graphql = graphql;
  }

  private onWebSocketHandshake(requestId: string | undefined, params: Params): void {
    if (!requestId) return;
    const ex = this.byId.get(requestId);
    if (ex && typeof params.wallTime === 'number') ex.startedAt = params.wallTime * 1000;
  }

  private onResponse(requestId: string | undefined, params: Params): void {
    if (!requestId) return;
    const res = asParams(params.response);
    const headers = toHeaders(res.headers);
    const ex = this.byId.get(requestId);
    const contentType = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
    const isEventStream = contentType.toLowerCase().includes('text/event-stream');
    if (ex) {
      ex.response = {
        status: typeof res.status === 'number' ? res.status : 0,
        ...(typeof res.statusText === 'string' ? { statusText: res.statusText } : {}),
        headers,
      };
      if (isEventStream && ex.protocol === 'rest') ex.protocol = 'sse';
    }
  }

  private onWebSocketCreated(requestId: string | undefined, params: Params): void {
    if (!requestId) return;
    const url = typeof params.url === 'string' ? params.url : '';
    this.ensure(requestId, () => ({
      id: requestId,
      protocol: 'websocket',
      method: 'GET',
      url,
      startedAt: 0,
      request: { headers: [] },
      frames: [],
    }));
  }

  private onFrame(
    requestId: string | undefined,
    params: Params,
    direction: CapturedFrame['direction']
  ): void {
    if (!requestId) return;
    const ex = this.byId.get(requestId);
    if (!ex) return;
    const response = asParams(params.response);
    ex.frames ??= [];
    ex.frames.push({
      direction,
      ...(typeof response.opcode === 'number' ? { opcode: response.opcode } : {}),
      payload: { text: typeof response.payloadData === 'string' ? response.payloadData : '' },
      at: this.toEpochMs(params.timestamp),
    });
  }

  private onSseMessage(requestId: string | undefined, params: Params): void {
    if (!requestId) return;
    const ex = this.byId.get(requestId);
    if (!ex) return;
    if (ex.protocol === 'rest') ex.protocol = 'sse';
    ex.frames ??= [];
    ex.frames.push({
      direction: 'received',
      payload: { text: typeof params.data === 'string' ? params.data : '' },
      at: this.toEpochMs(params.timestamp),
    });
  }
}
