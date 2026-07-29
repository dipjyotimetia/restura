import type {
  ClientRequest,
  Agent as HttpAgent,
  OutgoingHttpHeaders,
  RequestOptions,
} from 'node:http';
import * as net from 'node:net';
import type { Duplex } from 'node:stream';
import * as tls from 'node:tls';
import { Agent, type AgentConnectOpts } from 'agent-base';
import type { HttpsProxyAgentOptions } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

type ProxyAuthorizationLookup = (
  proxyUrl: string,
  challenge: string | string[] | undefined,
  state: Record<string, unknown>
) => Promise<string | undefined>;

type OrderedPacProxyAgentOptions = HttpsProxyAgentOptions<''> & {
  fallbackToDirect?: boolean;
  originalAgent?: false | HttpAgent;
  lookupProxyAuthorization?: ProxyAuthorizationLookup;
};

type PacResolver = (
  request: ClientRequest,
  options: RequestOptions,
  url: string
) => Promise<string | undefined>;

type ProxyAuthState = Record<string, unknown>;

export type DirectPacConnector = (
  request: ClientRequest,
  options: AgentConnectOpts
) => Promise<Duplex | HttpAgent>;

type ProxyResolveType =
  | 'DIRECT'
  | 'PROXY'
  | 'HTTP'
  | 'HTTPS'
  | 'SOCKS'
  | 'SOCKS5'
  | 'SOCKS4'
  | 'UNRECOGNIZED';

function parseProxyCandidate(candidate: string): {
  type: ProxyResolveType;
  url?: string;
} {
  const [rawType, target] = candidate.trim().split(/\s+/, 2);
  const type = rawType?.toUpperCase();
  if (type === 'DIRECT') return { type };
  if ((type === 'SOCKS' || type === 'SOCKS5') && target) {
    return { type, url: `socks://${target}` };
  }
  if (type === 'SOCKS4' && target) return { type, url: `socks4a://${target}` };
  if ((type === 'PROXY' || type === 'HTTP' || type === 'HTTPS') && target) {
    return { type, url: `${type === 'HTTPS' ? 'https' : 'http'}://${target}` };
  }
  return { type: 'UNRECOGNIZED' };
}

interface ConnectResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
}

function readConnectResponse(socket: net.Socket): Promise<ConnectResponse> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error('Managed proxy closed before completing CONNECT authentication'));
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 64 * 1024) {
        cleanup();
        reject(new Error('Managed proxy CONNECT response headers exceeded 64 KiB'));
        return;
      }
      const headerEnd = buffered.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const lines = buffered.subarray(0, headerEnd).toString('latin1').split('\r\n');
      const statusCode = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(lines.shift() ?? '')?.[1]);
      if (!Number.isInteger(statusCode)) {
        cleanup();
        reject(new Error('Managed proxy returned an invalid CONNECT response'));
        return;
      }
      const headers: Record<string, string | string[] | undefined> = {};
      for (const line of lines) {
        const separator = line.indexOf(':');
        if (separator <= 0) continue;
        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        const previous = headers[name];
        headers[name] = previous
          ? Array.isArray(previous)
            ? [...previous, value]
            : [previous, value]
          : value;
      }
      if (headers['transfer-encoding']) {
        cleanup();
        reject(new Error('Chunked managed proxy CONNECT authentication responses are unsupported'));
        return;
      }
      const contentLength = Number(headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > 64 * 1024) {
        cleanup();
        reject(new Error('Managed proxy CONNECT response body length is invalid'));
        return;
      }
      const responseEnd = headerEnd + 4 + contentLength;
      if (buffered.length < responseEnd) return;
      cleanup();
      const remainder = buffered.subarray(responseEnd);
      if (remainder.length) socket.unshift(remainder);
      resolve({ statusCode, headers });
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
  });
}

class AuthenticatedTunnelProxyAgent extends Agent {
  readonly proxy: URL;
  private readonly pacOptions: OrderedPacProxyAgentOptions;
  private readonly activeSockets = new Set<net.Socket>();
  private readonly lookupProxyAuthorization:
    | OrderedPacProxyAgentOptions['lookupProxyAuthorization']
    | undefined;

  constructor(proxy: string, options: OrderedPacProxyAgentOptions) {
    super(options);
    this.proxy = new URL(proxy);
    this.pacOptions = options;
    this.lookupProxyAuthorization = options.lookupProxyAuthorization;
  }

  override destroy(): void {
    for (const socket of this.activeSockets) socket.destroy();
    this.activeSockets.clear();
    super.destroy();
  }

  override async connect(
    request: ClientRequest,
    options: AgentConnectOpts,
    state: ProxyAuthState = {}
  ): Promise<net.Socket> {
    if (!options.host) throw new TypeError('No target host provided');
    const {
      headers: configuredHeaders,
      lookupProxyAuthorization: _lookup,
      originalAgent: _original,
      fallbackToDirect: _fallback,
      ...proxyTlsOptions
    } = this.pacOptions;
    const proxyHost = this.proxy.hostname.replace(/^\[|\]$/g, '');
    const proxyPort = Number(this.proxy.port || (this.proxy.protocol === 'https:' ? 443 : 80));
    const socket =
      this.proxy.protocol === 'https:'
        ? tls.connect({
            ...proxyTlsOptions,
            host: proxyHost,
            port: proxyPort,
            servername: net.isIP(proxyHost) ? undefined : proxyHost,
            ALPNProtocols: ['http/1.1'],
          })
        : net.connect({ host: proxyHost, port: proxyPort });
    this.activeSockets.add(socket);
    socket.once('close', () => this.activeSockets.delete(socket));
    let authorization = this.lookupProxyAuthorization
      ? await this.lookupProxyAuthorization(this.proxy.href, undefined, state)
      : undefined;
    const targetHost = net.isIPv6(options.host) ? `[${options.host}]` : options.host;

    try {
      for (let attempts = 0; attempts <= 8; attempts += 1) {
        const headers: OutgoingHttpHeaders = {
          ...(typeof configuredHeaders === 'function' ? configuredHeaders() : configuredHeaders),
          Host: `${targetHost}:${options.port}`,
          'Proxy-Connection': 'Keep-Alive',
          ...(authorization ? { 'Proxy-Authorization': authorization } : {}),
        };
        let payload = `CONNECT ${targetHost}:${options.port} HTTP/1.1\r\n`;
        for (const [name, value] of Object.entries(headers)) {
          if (value === undefined) continue;
          const serialized = Array.isArray(value) ? value.join(', ') : String(value);
          if (/[\r\n]/.test(name) || /[\r\n]/.test(serialized)) {
            throw new Error('Managed proxy authentication produced an invalid header');
          }
          payload += `${name}: ${serialized}\r\n`;
        }
        const responsePromise = readConnectResponse(socket);
        socket.write(`${payload}\r\n`);
        const response = await responsePromise;
        if (response.statusCode === 200) {
          request.emit('proxyConnect', response);
          if (!options.secureEndpoint) return socket;
          const {
            host: _host,
            port: _port,
            path: _path,
            secureEndpoint: _secureEndpoint,
            ...targetTlsOptions
          } = options;
          return tls.connect({
            ...targetTlsOptions,
            socket,
            servername: net.isIP(options.host) ? undefined : options.host,
          });
        }
        const challenge = response.headers['proxy-authenticate'];
        if (
          response.statusCode !== 407 ||
          !challenge ||
          !this.lookupProxyAuthorization ||
          attempts >= 8
        ) {
          throw new Error(`Managed proxy CONNECT failed with status ${response.statusCode}`);
        }
        if (String(response.headers.connection ?? '').toLowerCase() === 'close') {
          throw new Error('Managed proxy closed a connection-bound authentication exchange');
        }
        const nextAuthorization = await this.lookupProxyAuthorization(
          this.proxy.href,
          challenge,
          state
        );
        if (!nextAuthorization || nextAuthorization === authorization) {
          throw new Error('Managed proxy authentication did not advance after a 407 challenge');
        }
        authorization = nextAuthorization;
      }
      throw new Error('Managed proxy authentication exceeded 8 challenge rounds');
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }
}

/**
 * Enterprise PAC files commonly return an ordered failover chain. Try each
 * directive independently while preserving TLS, authentication, and the
 * policy-controlled pinned DIRECT connector.
 */
export class OrderedPacProxyAgent extends Agent {
  private readonly resolver: PacResolver;
  private readonly opts: OrderedPacProxyAgentOptions;
  private readonly childAgents = new Set<Agent>();
  private readonly connectedSockets = new Set<Duplex>();
  private destroyedByOwner = false;

  constructor(
    resolver: PacResolver,
    options: OrderedPacProxyAgentOptions,
    private readonly connectDirect?: DirectPacConnector
  ) {
    super(options);
    this.resolver = resolver;
    this.opts = options;
  }

  override destroy(): void {
    this.destroyedByOwner = true;
    for (const agent of this.childAgents) agent.destroy();
    for (const socket of this.connectedSockets) socket.destroy();
    this.childAgents.clear();
    this.connectedSockets.clear();
    super.destroy();
  }

  private retainSocket(socket: Duplex): Duplex {
    if (this.destroyedByOwner) {
      socket.destroy();
      throw new Error('Managed PAC agent was destroyed while connecting');
    }
    this.connectedSockets.add(socket);
    socket.once('close', () => this.connectedSockets.delete(socket));
    return socket;
  }

  override async connect(
    request: ClientRequest,
    options: AgentConnectOpts
  ): Promise<Duplex | HttpAgent> {
    const resolution = await this.resolver(request, options as RequestOptions, '');
    const candidates = String(resolution ?? '')
      .split(';')
      .map((candidate) => candidate.trim())
      .filter(Boolean);
    const failures: unknown[] = [];

    for (const candidate of candidates) {
      const parsed = parseProxyCandidate(candidate);
      if (parsed.type === 'DIRECT' && this.connectDirect) {
        try {
          return await this.connectDirect(request, options);
        } catch (error) {
          failures.push(error);
          continue;
        }
      }
      if (!parsed.url) continue;

      try {
        if (parsed.type === 'PROXY' || parsed.type === 'HTTP' || parsed.type === 'HTTPS') {
          const child = new AuthenticatedTunnelProxyAgent(parsed.url, this.opts);
          this.childAgents.add(child);
          try {
            return this.retainSocket(await child.connect(request, options));
          } catch (error) {
            child.destroy();
            this.childAgents.delete(child);
            throw error;
          }
        }
        if (parsed.type.startsWith('SOCKS')) {
          const child = new SocksProxyAgent(
            parsed.url,
            this.opts as ConstructorParameters<typeof SocksProxyAgent>[1]
          );
          this.childAgents.add(child);
          try {
            return this.retainSocket(await child.connect(request, options));
          } catch (error) {
            child.destroy();
            this.childAgents.delete(child);
            throw error;
          }
        }
        throw new Error(`Unsupported managed PAC candidate: ${candidate}`);
      } catch (error) {
        failures.push(error);
      }
    }

    const reasons = failures
      .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
      .join('; ');
    throw new AggregateError(
      failures,
      `Failed to establish a socket connection through ${candidates.length} managed PAC candidates${reasons ? `: ${reasons}` : ''}`
    );
  }
}

export function createOrderedPacProxyAgent(
  resolver: PacResolver,
  options: OrderedPacProxyAgentOptions,
  connectDirect?: DirectPacConnector
): OrderedPacProxyAgent {
  return new OrderedPacProxyAgent(resolver, options, connectDirect);
}
