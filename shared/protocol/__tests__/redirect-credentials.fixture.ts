/**
 * One table for redirect header handling. The Worker (and self-host, which shares
 * its app), the CLI and Electron each run it through their own entry point:
 * worker/handlers/__tests__/redirect-credentials.parity.test.ts,
 * cli/src/runner/executors/__tests__/redirect-credentials.parity.test.ts and
 * electron/main/__tests__/http-handler-redirects.test.ts.
 */
import type { AuthConfig } from '../../types';

export const REDIRECT_START = 'https://api.example.com/start';
export const OTHER_ORIGIN = 'https://other.example.com/next';
export const SAME_ORIGIN = '/next';

export const SENT_HEADERS: Record<string, string> = {
  Authorization: 'Bearer t',
  Cookie: 'a=1',
  'Proxy-Authorization': 'Basic p',
  'X-Api-Key': 'k',
  'X-Auth-Token': 'k',
  AccessToken: 'k',
  AuthToken: 'k',
  ApiToken: 'k',
  clientSecret: 'k',
  Accept: 'application/json',
  'User-Agent': 'restura',
  'X-Request-Id': 'r',
  'X-Trace': 'abc',
};

export const KEPT_ON_ORIGIN_CHANGE = ['accept', 'user-agent', 'x-request-id', 'x-trace'];
export const STRIPPED_ON_ORIGIN_CHANGE = [
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'accesstoken',
  'authtoken',
  'apitoken',
  'clientsecret',
  'x-unusual',
];

export const API_KEY_AUTH: AuthConfig = {
  type: 'api-key',
  apiKey: { key: 'X-Unusual', value: 'v', in: 'header' },
};
export const WSSE_AUTH = {
  type: 'wsse',
  wsse: { username: 'u', password: 'p' },
} as AuthConfig;
