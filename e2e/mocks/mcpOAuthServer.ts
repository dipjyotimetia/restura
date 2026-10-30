import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { bindLocalhost, closeServer, readBody } from '../utils/serverHelpers';

/**
 * Minimal spec-shaped OAuth 2.1 authorization server for MCP auth tests
 * (#856): RFC 8414 metadata, RFC 7591 dynamic registration, an
 * auto-approving `/authorize` (PKCE S256 + RFC 8707 `resource` enforced,
 * RFC 9207 `iss` on the redirect), and `/token` for the authorization_code
 * and refresh_token grants. Static clients may be confidential
 * (client_secret_basic / client_secret_post).
 */

export interface MockOAuthServerOptions {
  /** Bind a fixed port (echo-local); default 0 = ephemeral. */
  port?: number;
  /** Access-token lifetime in seconds (default 3600). */
  expiresIn?: number;
  /** Pre-registered clients: id → secret (null = public client). */
  staticClients?: Record<string, string | null>;
  /** Advertise a different `issuer` than the URL it's served from (mix-up test). */
  issuerOverride?: string;
  scopesSupported?: string[];
}

export interface MockOAuthServerHandle {
  url: string;
  issuer: string;
  close: () => Promise<void>;
  /** RFC 7591 registration bodies received. */
  registrations: Array<Record<string, unknown>>;
  authorizeRequests: URLSearchParams[];
  tokenRequests: Array<{ params: URLSearchParams; authorization: string }>;
  /** Every access token ever issued, in order. */
  issuedAccessTokens: string[];
  issuedRefreshTokens: string[];
  isValidAccessToken: (token: string) => boolean;
  /** Invalidate every issued access token (the resource answers 401 next). */
  revokeAccessTokens: () => void;
  /** Make the refresh_token grant fail with invalid_grant. */
  setFailRefresh: (fail: boolean) => void;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string | null;
  scope: string | null;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function clientAuth(
  req: IncomingMessage,
  params: URLSearchParams
): { id: string | null; secret: string | null } {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Basic ')) {
    const [id, secret] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
    return {
      id: decodeURIComponent(id ?? ''),
      secret: decodeURIComponent(secret ?? ''),
    };
  }
  return { id: params.get('client_id'), secret: params.get('client_secret') };
}

export async function startMockOAuthServer(
  opts: MockOAuthServerOptions = {}
): Promise<MockOAuthServerHandle> {
  const expiresIn = opts.expiresIn ?? 3600;
  const clients = new Map<string, { secret: string | null; redirectUris: string[] | null }>();
  for (const [id, secret] of Object.entries(opts.staticClients ?? {})) {
    clients.set(id, { secret, redirectUris: null });
  }
  const codes = new Map<string, PendingCode>();
  const refreshTokens = new Map<string, { clientId: string; resource: string | null }>();
  const validAccess = new Set<string>();
  let failRefresh = false;

  const handle: MockOAuthServerHandle = {
    url: '',
    issuer: '',
    close: async () => undefined,
    registrations: [],
    authorizeRequests: [],
    tokenRequests: [],
    issuedAccessTokens: [],
    issuedRefreshTokens: [],
    isValidAccessToken: (token) => validAccess.has(token),
    revokeAccessTokens: () => validAccess.clear(),
    setFailRefresh: (fail) => {
      failRefresh = fail;
    },
  };

  function issue(clientId: string, resource: string | null, scope: string | null) {
    const access = `at_${b64url(randomBytes(24))}`;
    const refresh = `rt_${b64url(randomBytes(24))}`;
    validAccess.add(access);
    refreshTokens.set(refresh, { clientId, resource });
    handle.issuedAccessTokens.push(access);
    handle.issuedRefreshTokens.push(refresh);
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refresh,
      ...(scope ? { scope } : {}),
    };
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', handle.url);
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
        json(res, 200, {
          issuer: handle.issuer,
          authorization_endpoint: `${handle.url}/authorize`,
          token_endpoint: `${handle.url}/token`,
          registration_endpoint: `${handle.url}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: [
            'none',
            'client_secret_basic',
            'client_secret_post',
          ],
          authorization_response_iss_parameter_supported: true,
          ...(opts.scopesSupported ? { scopes_supported: opts.scopesSupported } : {}),
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/register') {
        const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
        handle.registrations.push(body);
        const redirectUris = Array.isArray(body.redirect_uris)
          ? (body.redirect_uris as string[])
          : [];
        if (redirectUris.length === 0) {
          json(res, 400, { error: 'invalid_redirect_uri' });
          return;
        }
        const clientId = `dcr_${b64url(randomBytes(9))}`;
        clients.set(clientId, { secret: null, redirectUris });
        json(res, 201, {
          ...body,
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/authorize') {
        const p = url.searchParams;
        handle.authorizeRequests.push(p);
        const client = clients.get(p.get('client_id') ?? '');
        const redirectUri = p.get('redirect_uri') ?? '';
        const redirectOk = client?.redirectUris
          ? client.redirectUris.includes(redirectUri)
          : /^http:\/\/127\.0\.0\.1:\d+\//.test(redirectUri); // RFC 8252 §7.3: any port
        if (
          !client ||
          !redirectOk ||
          p.get('response_type') !== 'code' ||
          p.get('code_challenge_method') !== 'S256' ||
          !p.get('code_challenge')
        ) {
          json(res, 400, { error: 'invalid_request' });
          return;
        }
        const code = `code_${b64url(randomBytes(18))}`;
        codes.set(code, {
          clientId: p.get('client_id')!,
          redirectUri,
          challenge: p.get('code_challenge')!,
          resource: p.get('resource'),
          scope: p.get('scope'),
        });
        const location = new URL(redirectUri);
        location.searchParams.set('code', code);
        if (p.get('state') !== null) location.searchParams.set('state', p.get('state')!);
        location.searchParams.set('iss', handle.issuer);
        res.writeHead(302, { location: location.href });
        res.end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        const params = new URLSearchParams(await readBody(req));
        handle.tokenRequests.push({ params, authorization: req.headers.authorization ?? '' });
        const { id, secret } = clientAuth(req, params);
        const client = clients.get(id ?? '');
        if (!client || (client.secret !== null && client.secret !== secret)) {
          json(res, 401, { error: 'invalid_client' });
          return;
        }
        if (params.get('grant_type') === 'authorization_code') {
          const pending = codes.get(params.get('code') ?? '');
          codes.delete(params.get('code') ?? '');
          const verifier = params.get('code_verifier') ?? '';
          if (
            !pending ||
            pending.clientId !== id ||
            pending.redirectUri !== params.get('redirect_uri') ||
            b64url(createHash('sha256').update(verifier).digest()) !== pending.challenge ||
            pending.resource !== params.get('resource')
          ) {
            json(res, 400, { error: 'invalid_grant' });
            return;
          }
          json(res, 200, issue(id!, pending.resource, pending.scope));
          return;
        }
        if (params.get('grant_type') === 'refresh_token') {
          const rt = refreshTokens.get(params.get('refresh_token') ?? '');
          if (failRefresh || !rt || rt.clientId !== id) {
            json(res, 400, { error: 'invalid_grant' });
            return;
          }
          refreshTokens.delete(params.get('refresh_token')!);
          json(res, 200, issue(id!, rt.resource, null));
          return;
        }
        json(res, 400, { error: 'unsupported_grant_type' });
        return;
      }
      json(res, 404, { error: 'not_found' });
    })().catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    });
  });

  const port = await bindLocalhost(server, opts.port);
  handle.url = `http://127.0.0.1:${port}`;
  handle.issuer = opts.issuerOverride ?? handle.url;
  handle.close = () => closeServer(server);
  return handle;
}
