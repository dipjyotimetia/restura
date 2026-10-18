/**
 * Connect-time glue between the `mcp:connect` IPC payload and the main-side
 * MCP OAuth session (#856, ADR 0031), plus the plaintext-free
 * `mcp:oauth:status` / `mcp:oauth:signOut` channels.
 *
 * The renderer sends only the flow configuration — client id, an optional
 * client secret as a SecretRef (desktop editors store it as a keychain
 * handle), scope and an optional fixed loopback redirect URI. Tokens, DCR
 * registrations, PKCE verifiers and authorization codes never cross IPC.
 */

import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '../../shared/channels';
import { createKeyedRateLimiter, rateLimited } from '../ipc/ipc-rate-limiter';
import { createValidatedEventHandler } from '../ipc/ipc-validators';
import { type McpOAuthDeps, McpOAuthSession, parseLoopbackRedirect } from './mcp-oauth-provider';
import { clearMcpOAuthRecord, type McpOAuthStatus, mcpOAuthStatus } from './mcp-oauth-store';
import { unwrapSecretValueMain } from './secret-handle-store';

const CLIENT_ID_RE = /^[\x21-\x7e]{1,512}$/;
const SCOPE_RE = /^[\x21\x23-\x5b\x5d-\x7e]+( [\x21\x23-\x5b\x5d-\x7e]+)*$/;

function isOpaqueExternalRef(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind !== 'inline' &&
    (value as { kind?: unknown }).kind !== 'handle'
  );
}

/**
 * Build the OAuth session for an `oauth2` MCP auth without an access token.
 * Throws plaintext-free errors for a malformed configuration or a client
 * secret that can't be resolved.
 */
export interface McpOAuthAuthInput {
  oauth2?:
    | {
        clientId?: string | undefined;
        clientSecret?: unknown;
        scope?: string | undefined;
        redirectUri?: string | undefined;
      }
    | undefined;
}

export function createMcpOAuthSession(
  serverUrl: string,
  auth: McpOAuthAuthInput,
  deps: McpOAuthDeps = {}
): McpOAuthSession {
  const o = auth.oauth2 ?? {};
  const clientId = o.clientId?.trim() || undefined;
  if (clientId && !CLIENT_ID_RE.test(clientId)) {
    throw new Error('OAuth client id contains invalid characters');
  }
  const scope = o.scope?.trim() || undefined;
  if (scope && (scope.length > 2048 || !SCOPE_RE.test(scope))) {
    throw new Error('OAuth scope must be space-separated scope tokens');
  }
  const redirectUrl = o.redirectUri?.trim() || undefined;
  if (redirectUrl) parseLoopbackRedirect(redirectUrl);

  let clientSecret: string | undefined;
  if (o.clientSecret !== undefined && o.clientSecret !== '') {
    if (!clientId) {
      throw new Error(
        'An OAuth client secret needs a client id (dynamic registration issues its own)'
      );
    }
    if (isOpaqueExternalRef(o.clientSecret)) {
      throw new Error('External-vault client secrets are not supported for MCP OAuth yet');
    }
    clientSecret = unwrapSecretValueMain(o.clientSecret);
    if (!clientSecret) {
      throw new Error('The OAuth client secret is unavailable (missing or revoked keychain entry)');
    }
  }

  return new McpOAuthSession(
    {
      serverUrl,
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(scope ? { scope } : {}),
      ...(redirectUrl ? { redirectUrl } : {}),
    },
    deps
  );
}

const McpOAuthTargetSchema = z
  .object({
    url: z
      .string()
      .url()
      .max(4096)
      .refine((u) => ['http:', 'https:'].includes(new URL(u).protocol), {
        message: 'Only http: and https: URLs are allowed',
      }),
    clientId: z.string().max(512).optional(),
  })
  .strict();

export const mcpOAuthRateLimiter = createKeyedRateLimiter(60, 60_000);

function clientIdOf(input: { clientId?: string | undefined }): string | undefined {
  return input.clientId?.trim() || undefined;
}

export function registerMcpOAuthIPC(): void {
  ipcMain.handle(
    IPC.mcp.oauthStatus,
    rateLimited(
      mcpOAuthRateLimiter,
      createValidatedEventHandler(
        IPC.mcp.oauthStatus,
        McpOAuthTargetSchema,
        async (input): Promise<McpOAuthStatus> => mcpOAuthStatus(input.url, clientIdOf(input))
      )
    )
  );
  ipcMain.handle(
    IPC.mcp.oauthSignOut,
    rateLimited(
      mcpOAuthRateLimiter,
      createValidatedEventHandler(IPC.mcp.oauthSignOut, McpOAuthTargetSchema, async (input) => {
        clearMcpOAuthRecord(input.url, clientIdOf(input));
        return { success: true };
      })
    )
  );
}

export function unregisterMcpOAuthIPC(): void {
  ipcMain.removeHandler(IPC.mcp.oauthStatus);
  ipcMain.removeHandler(IPC.mcp.oauthSignOut);
}
