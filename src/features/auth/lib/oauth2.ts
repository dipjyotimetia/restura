export interface OAuth2TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface OAuth2FlowConfig {
  grantType: 'authorization_code' | 'client_credentials' | 'password' | 'device_code';
  clientId: string;
  clientSecret?: string;
  tokenUrl: string;
  authorizationUrl?: string;
  /** Explicit device authorization endpoint (RFC 8628 §3.1). Required for device_code grant. */
  deviceAuthorizationUrl?: string;
  redirectUri?: string;
  scope?: string;
  // Password grant
  username?: string;
  password?: string;
}

export interface OAuth2Error {
  error: string;
  error_description?: string;
}

/** Carries the machine-readable RFC 6749 error code alongside the human-readable message. */
export class OAuth2TokenError extends Error {
  constructor(
    public readonly errorCode: string,
    message: string
  ) {
    super(message);
    this.name = 'OAuth2TokenError';
  }
}

async function postToken(
  tokenUrl: string,
  params: Record<string, string>,
  signal?: AbortSignal
): Promise<OAuth2TokenResponse> {
  const body = new URLSearchParams(params).toString();
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    ...(signal ? { signal } : {}),
  });

  const json = (await response.json()) as OAuth2TokenResponse | OAuth2Error;

  if (!response.ok || 'error' in json) {
    const err = json as OAuth2Error;
    throw new OAuth2TokenError(
      err.error || 'unknown_error',
      err.error_description || err.error || `Token request failed: ${response.status}`
    );
  }

  return json as OAuth2TokenResponse;
}

export async function fetchClientCredentialsToken(
  config: OAuth2FlowConfig
): Promise<OAuth2TokenResponse> {
  const params: Record<string, string> = {
    grant_type: 'client_credentials',
    client_id: config.clientId,
  };
  if (config.clientSecret) params.client_secret = config.clientSecret;
  if (config.scope) params.scope = config.scope;

  return postToken(config.tokenUrl, params);
}

export async function fetchPasswordToken(config: OAuth2FlowConfig): Promise<OAuth2TokenResponse> {
  if (!config.username || !config.password) {
    throw new Error('Username and password are required for password grant');
  }
  const params: Record<string, string> = {
    grant_type: 'password',
    client_id: config.clientId,
    username: config.username,
    password: config.password,
  };
  if (config.clientSecret) params.client_secret = config.clientSecret;
  if (config.scope) params.scope = config.scope;

  return postToken(config.tokenUrl, params);
}

// PKCE helpers
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export async function buildAuthorizationUrl(
  config: OAuth2FlowConfig
): Promise<{ url: string; codeVerifier: string; state: string }> {
  if (!config.authorizationUrl) throw new Error('Authorization URL is required');
  if (!config.redirectUri) throw new Error('Redirect URI is required');

  const state = crypto.randomUUID();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  if (config.scope) params.set('scope', config.scope);

  return { url: `${config.authorizationUrl}?${params}`, codeVerifier, state };
}

export async function exchangeCodeForToken(
  config: OAuth2FlowConfig,
  code: string,
  codeVerifier: string
): Promise<OAuth2TokenResponse> {
  if (!config.redirectUri) throw new Error('Redirect URI is required');

  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
  };
  if (config.clientSecret) params.client_secret = config.clientSecret;

  return postToken(config.tokenUrl, params);
}

// Opens the auth URL in a popup and waits for the redirect to contain a `code` param.
// Works when `redirectUri` is the same origin. Returns null if closed/cancelled.
export async function authorizeWithPopup(
  authUrl: string,
  expectedState: string,
  timeoutMs = 300_000
): Promise<{ code: string } | null> {
  return new Promise((resolve) => {
    // Omitting `noopener` so window.open() returns a non-null reference we can poll.
    // The popup starts cross-origin (auth server), so it cannot reach window.opener anyway.
    const popup = window.open(authUrl, 'oauth2_popup', 'width=600,height=700');
    if (!popup) {
      resolve(null);
      return;
    }

    const deadline = Date.now() + timeoutMs;
    const check = setInterval(() => {
      try {
        if (popup.closed) {
          clearInterval(check);
          resolve(null);
          return;
        }
        const url = new URL(popup.location.href);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (code && state === expectedState) {
          clearInterval(check);
          popup.close();
          resolve({ code });
        }
      } catch {
        // Cross-origin — popup is still on auth server; keep polling
      }
      if (Date.now() > deadline) {
        clearInterval(check);
        popup.close();
        resolve(null);
      }
    }, 500);
  });
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export async function fetchDeviceCode(config: OAuth2FlowConfig): Promise<DeviceCodeResponse> {
  // RFC 8628 §3.1 requires a dedicated device_authorization_url published in server metadata.
  // A string-replace on tokenUrl is a heuristic that breaks for non-standard paths.
  if (!config.deviceAuthorizationUrl) {
    throw new Error('Device Authorization URL is required for the device code flow');
  }

  const params: Record<string, string> = { client_id: config.clientId };
  if (config.scope) params.scope = config.scope;

  const body = new URLSearchParams(params).toString();
  const response = await fetch(config.deviceAuthorizationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });

  if (!response.ok) {
    throw new Error(`Device code request failed: ${response.status}`);
  }

  return response.json() as Promise<DeviceCodeResponse>;
}

export async function pollForDeviceToken(
  config: OAuth2FlowConfig,
  deviceCode: string,
  intervalSeconds = 5,
  maxAttempts = 60
): Promise<OAuth2TokenResponse> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalSeconds * 1000));

    const params: Record<string, string> = {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: config.clientId,
      device_code: deviceCode,
    };

    try {
      return await postToken(config.tokenUrl, params);
    } catch (err) {
      // RFC 8628 §3.5 — keep polling on these two codes; any other error is terminal
      if (
        err instanceof OAuth2TokenError &&
        (err.errorCode === 'authorization_pending' || err.errorCode === 'slow_down')
      ) {
        continue;
      }
      throw err;
    }
  }

  throw new Error('Device code flow timed out');
}

export interface RefreshTokenConfig {
  clientId: string;
  tokenUrl: string;
  refreshToken: string;
  clientSecret?: string;
  scope?: string;
}

export async function fetchRefreshToken(
  config: RefreshTokenConfig,
  signal?: AbortSignal
): Promise<OAuth2TokenResponse> {
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: config.refreshToken,
  };
  if (config.clientSecret) params.client_secret = config.clientSecret;
  if (config.scope) params.scope = config.scope;
  return postToken(config.tokenUrl, params, signal);
}

export function tokenExpiresAt(nowMs: number, expiresInSeconds?: number): number | undefined {
  return expiresInSeconds ? nowMs + expiresInSeconds * 1000 : undefined;
}
