/**
 * Capture data model — backend-agnostic.
 *
 * The single normalized shape that CDP events are reduced to before redaction
 * and export. Shared by the browser extension (which produces it from
 * `chrome.debugger` events) and the Electron desktop bridge (which consumes it).
 * Like the rest of `shared/`, this module never imports from `src/`.
 */

export type CapturedProtocol = 'rest' | 'graphql' | 'grpc-web' | 'websocket' | 'sse';

export interface CapturedHeader {
  name: string;
  value: string;
}

export interface CapturedBody {
  /** UTF-8 text body, when the payload is textual. */
  text?: string;
  /** Base64 body, when the payload is binary. */
  base64?: string;
  mimeType?: string;
  /** True when the captured body was clipped (CDP size cap). */
  truncated?: boolean;
}

/** A single WebSocket / SSE frame. */
export interface CapturedFrame {
  direction: 'sent' | 'received';
  /** WebSocket opcode (1=text, 2=binary, …); omitted for SSE. */
  opcode?: number;
  payload: CapturedBody;
  at: number;
}

export interface CapturedGraphql {
  operationName?: string;
  operationType?: 'query' | 'mutation' | 'subscription';
}

export interface CapturedExchange {
  /** Stable id (CDP requestId for HTTP, a synthetic id for sockets). */
  id: string;
  protocol: CapturedProtocol;
  method: string;
  url: string;
  startedAt: number;
  request: {
    headers: CapturedHeader[];
    body?: CapturedBody;
  };
  response?: {
    status: number;
    statusText?: string;
    headers: CapturedHeader[];
    body?: CapturedBody;
  };
  /** Present for websocket / sse exchanges. */
  frames?: CapturedFrame[];
  graphql?: CapturedGraphql;
}

export interface CaptureSession {
  id: string;
  createdAt: number;
  /** Page origin the capture was started on, when known. */
  origin?: string;
  exchanges: CapturedExchange[];
}
