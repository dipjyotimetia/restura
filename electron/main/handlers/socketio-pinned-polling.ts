import type {
  ClientRequest,
  IncomingMessage,
  OutgoingHttpHeaders,
  RequestOptions,
} from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type * as SocketIoClient from 'socket.io-client';

/**
 * Socket.IO HTTP long-polling transport for Electron main that never follows
 * redirects.
 *
 * engine.io-client's default Node polling transport (`xmlhttprequest-ssl`)
 * re-issues 302/303/307 responses itself with a fresh options object — no
 * `agent` (so no pinned `lookup`, system DNS), no policy check on the new host,
 * and the user's `extraHeaders` replayed. This transport issues every poll and
 * write through `http(s).request` with the handler's DNS-pinned agent, and
 * Node's `http.request` never follows redirects: a 3xx is surfaced as a
 * transport error, so the connection only ever talks to the validated host.
 *
 * It subclasses engine.io-client's public `Fetch` polling transport (re-exported
 * by socket.io-client) so packet framing, the poll cycle and upgrade probing are
 * unchanged — only the wire request differs.
 */

type SocketIoModule = typeof SocketIoClient;
type FetchTransport = SocketIoModule['Fetch'];

/** Upper bound on one polling response body (server default is 1 MB/packet). */
export const MAX_POLLING_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Error text for a redirected polling request. */
export function pollingRedirectMessage(status: number): string {
  return `Server redirected the Socket.IO polling request (HTTP ${status}); redirects aren't followed`;
}

/** TLS/agent options forwarded to the request (same set engine.io's XHR transport forwards). */
const FORWARDED_OPTIONS = [
  'agent',
  'pfx',
  'key',
  'passphrase',
  'cert',
  'ca',
  'ciphers',
  'rejectUnauthorized',
] as const;

const cache = new WeakMap<FetchTransport, FetchTransport>();

/** Build (memoized per base class) the redirect-free polling transport. */
export function createPinnedPollingTransport(Base: FetchTransport): FetchTransport {
  const existing = cache.get(Base);
  if (existing) return existing;

  class PinnedPolling extends Base {
    private readonly inFlight = new Set<ClientRequest>();

    override doPoll(): void {
      this.pinnedRequest(undefined).then(
        (data) => this.onData(data),
        (err: Error) => this.onError(err.message, err)
      );
    }

    override doWrite(data: string, callback: () => void): void {
      this.pinnedRequest(data).then(
        () => callback(),
        (err: Error) => this.onError(err.message, err)
      );
    }

    // engine.io's `CloseDetails` type isn't exported; pass it through untouched.
    protected override onClose(details?: unknown): void {
      for (const req of this.inFlight) req.destroy();
      this.inFlight.clear();
      super.onClose(details as never);
    }

    private pinnedRequest(body: string | undefined): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const opts = this.opts as unknown as Record<string, unknown> & {
          extraHeaders?: Record<string, string>;
          secure?: boolean;
        };
        const target = new URL(this.uri());

        const headers = new Headers(opts.extraHeaders ?? {});
        if (body !== undefined) headers.set('content-type', 'text/plain;charset=UTF-8');
        this.socket?._cookieJar?.appendCookies(headers);
        const outgoing: OutgoingHttpHeaders = {};
        headers.forEach((value, name) => {
          outgoing[name] = value;
        });
        if (body !== undefined) outgoing['content-length'] = Buffer.byteLength(body);

        const forwarded: Record<string, unknown> = {};
        for (const key of FORWARDED_OPTIONS) {
          if (opts[key] !== undefined && opts[key] !== null) forwarded[key] = opts[key];
        }
        const requestOptions: RequestOptions = {
          ...(forwarded as RequestOptions),
          method: body === undefined ? 'GET' : 'POST',
          headers: outgoing,
        };

        const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
        const req = send(target, requestOptions, (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          const setCookie = res.headers['set-cookie'];
          if (setCookie) this.socket?._cookieJar?.parseCookies(setCookie);
          if (status >= 300 && status < 400) {
            res.resume();
            reject(new Error(pollingRedirectMessage(status)));
            return;
          }
          if (status < 200 || status >= 300) {
            res.resume();
            reject(
              new Error(
                `Socket.IO polling ${body === undefined ? 'read' : 'write'} error (HTTP ${status})`
              )
            );
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_POLLING_RESPONSE_BYTES) {
              req.destroy(new Error('Socket.IO polling response exceeded the size limit'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          res.on('error', reject);
        });
        this.inFlight.add(req);
        req.on('close', () => this.inFlight.delete(req));
        req.on('error', reject);
        req.end(body);
      });
    }
  }

  cache.set(Base, PinnedPolling);
  return PinnedPolling;
}
