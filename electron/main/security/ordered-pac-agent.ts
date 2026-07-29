import { EventEmitter } from 'node:events';
import type { Agent, ClientRequest, OutgoingHttpHeaders, RequestOptions } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  createPacProxyAgent,
  getProxyURLFromResolverResult,
  PacProxyAgent,
} from '@vscode/proxy-agent/out/agent';
import type { AgentConnectOpts } from 'agent-base';
import { HttpsProxyAgent } from 'https-proxy-agent';

type PacProxyAgentOptions = NonNullable<ConstructorParameters<typeof PacProxyAgent>[1]>;
type PacResolver = ConstructorParameters<typeof PacProxyAgent>[0];
type ProxyAuthState = Record<string, unknown>;
export type DirectPacConnector = (
  request: ClientRequest,
  options: AgentConnectOpts
) => Promise<Duplex | Agent>;

class AuthenticatedTunnelProxyAgent extends HttpsProxyAgent<string> {
  private readonly addedHeaders: OutgoingHttpHeaders = {};
  private readonly lookupProxyAuthorization: PacProxyAgentOptions['lookupProxyAuthorization'];

  constructor(proxy: string, options: PacProxyAgentOptions) {
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
 * The upstream PAC agent selects only the first recognized directive. Enterprise
 * PAC files commonly return an ordered failover chain, so try each directive
 * independently while preserving the same TLS and authentication policy.
 */
export class OrderedPacProxyAgent extends PacProxyAgent {
  constructor(
    resolver: PacResolver,
    options: PacProxyAgentOptions,
    private readonly connectDirect?: DirectPacConnector
  ) {
    super(resolver, options);
  }

  override async connect(
    request: ClientRequest,
    options: AgentConnectOpts
  ): Promise<Duplex | Agent> {
    const resolution = await this.resolver(request, options as RequestOptions, '');
    const candidates = String(resolution ?? '')
      .split(';')
      .map((candidate) => candidate.trim())
      .filter(Boolean);
    const failures: unknown[] = [];

    for (const candidate of candidates) {
      const parsed = getProxyURLFromResolverResult(candidate);
      if (parsed.type === 'DIRECT' && this.connectDirect) {
        try {
          return await this.connectDirect(request, options);
        } catch (error) {
          failures.push(error);
          continue;
        }
      }
      // Never turn an unrecognized or disallowed DIRECT directive into
      // unpinned egress.
      if (!parsed.url) continue;

      try {
        if (
          parsed.url &&
          (parsed.type === 'PROXY' || parsed.type === 'HTTP' || parsed.type === 'HTTPS')
        ) {
          return await new AuthenticatedTunnelProxyAgent(parsed.url, this.opts).connect(
            request,
            options
          );
        }

        const agent = createPacProxyAgent(async () => candidate, this.opts);
        return await agent.connect(request, options);
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
  options: PacProxyAgentOptions,
  connectDirect?: DirectPacConnector
): OrderedPacProxyAgent {
  return new OrderedPacProxyAgent(resolver, options, connectDirect);
}
