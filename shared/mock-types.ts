/**
 * Mock-server IPC contract shapes. Compiled by the renderer
 * (`buildMockRoutes`) and replayed by the Electron main-process handler
 * (electron/main/handlers/mock-server-handler.ts). Defined once here so the
 * producer and consumer can't drift. Mock is desktop-only (capabilities
 * `mock.localServer`) — the web build can't bind a local listener.
 */

export interface MockRoute {
  /** Upper-case HTTP method, or '*' to match any method. */
  method: string;
  /** Pathname pattern. Supports `:param` / `{param}` segments and a trailing `*`. */
  path: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  /** When 'base64', `body` is base64 of binary bytes and is served decoded. */
  bodyEncoding?: 'base64';
  /** Artificial latency before responding, in ms. */
  delayMs?: number;
}

/** Renderer-side view of the mock server's running state. */
export interface MockServerStatus {
  running: boolean;
  port?: number;
  baseUrl?: string;
  collectionId?: string;
  routeCount?: number;
}
