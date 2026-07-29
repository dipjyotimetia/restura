import { EventEmitter } from 'node:events';
import type {
  ClientRequest,
  Agent as HttpAgent,
  OutgoingHttpHeaders,
  RequestOptions,
} from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { Agent, type AgentConnectOpts } from 'agent-base';
import { HttpsProxyAgent, type HttpsProxyAgentOptions } from 'https-proxy-agent';
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

class AuthenticatedTunnelProxyAgent extends HttpsProxyAgent<string> {
  private readonly addedHeaders: OutgoingHttpHeaders = {};
  private readonly lookupProxyAuthorization:
    | OrderedPacProxyAgentOptions['lookupProxyAuthorization']
    | undefined;

  constructor(proxy: string, options: OrderedPacProxyAgentOptions) {
    const originalHeaders = options.headers;
    const addedHeaders: OutgoingHttpHeaders = {};
    super(proxy, {
      ...options,
      headers: () => ({
        ...(typeof originalHeaders === 'function' ? originalHeaders() : originalHeaders),
        ...addedHeaders,
      }),
    });
    this.addedHeaders = addedHeaders;
    this.lookupProxyAuthorization = options.lookupProxyAuthorization;
  }

  override async connect(
    request: ClientRequest,
    options: AgentConnectOpts,
    state: ProxyAuthState = {}
  ): Promise<Socket> {
    const proxyRequest = new EventEmitter();
    let response:
      | { statusCode: number; headers: Record<string, string | string[] | undefined> }
      | undefined;
    proxyRequest.once('proxyConnect', (value) => {
      response = value;
    });

    if (this.lookupProxyAuthorization && !this.addedHeaders['Proxy-Authorization']) {
      const authorization = await this.lookupProxyAuthorization(this.proxy.href, undefined, state);
      if (authorization) this.addedHeaders['Proxy-Authorization'] = authorization;
    }

    const socket = await super.connect(proxyRequest as ClientRequest, options);
    const challenge = response?.headers['proxy-authenticate'];
    if (this.lookupProxyAuthorization && response?.statusCode === 407 && challenge) {
      const attempts = typeof state.authAttempts === 'number' ? state.authAttempts : 0;
      if (attempts >= 8) {
        socket.destroy();
        throw new Error('Managed proxy authentication exceeded 8 challenge rounds');
      }
      state.authAttempts = attempts + 1;
      const authorization = await this.lookupProxyAuthorization(this.proxy.href, challenge, state);
      if (authorization && authorization !== this.addedHeaders['Proxy-Authorization']) {
        this.addedHeaders['Proxy-Authorization'] = authorization;
        socket.destroy();
        return this.connect(request, options, state);
      }
    }

    if (response?.statusCode !== 200) {
      socket.destroy();
      throw new Error(
        `Managed proxy CONNECT failed with status ${response?.statusCode ?? 'unknown'}`
      );
    }
    request.emit('proxyConnect', response);
    request.once('socket', (connectedSocket) => {
      setImmediate(() => proxyRequest.emit('socket', connectedSocket));
    });
    return socket;
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

  constructor(
    resolver: PacResolver,
    options: OrderedPacProxyAgentOptions,
    private readonly connectDirect?: DirectPacConnector
  ) {
    super(options);
    this.resolver = resolver;
    this.opts = options;
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
          return await new AuthenticatedTunnelProxyAgent(parsed.url, this.opts).connect(
            request,
            options
          );
        }
        if (parsed.type.startsWith('SOCKS')) {
          return await new SocksProxyAgent(
            parsed.url,
            this.opts as ConstructorParameters<typeof SocksProxyAgent>[1]
          ).connect(request, options);
        }
        throw new Error(`Unsupported managed PAC candidate: ${candidate}`);
      } catch (error) {
        failures.push(error);
      }
    }

    throw new AggregateError(
      failures,
      `Failed to establish a socket connection through ${candidates.length} managed PAC candidates`
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
