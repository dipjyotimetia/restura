/**
 * Connect flow for the desktop-only MCP stdio transport (#854, ADR 0030).
 *
 * Kept out of mcp-handler.ts so the security-relevant ordering is readable in
 * one place: cwd check → consent (native dialog owned by main) → claim still
 * current → materialize secrets → allowlisted env → spawn (no shell) →
 * handshake. The handler owns claims and the session registry; this module
 * owns the process.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import type { Logger } from '@shared/runtime/logger';
import type { WebContents } from 'electron';
import { EVENT_PREFIX } from '../../shared/channels';
import { errorMessage } from '../ipc/ipc-utils';
import type { McpStdioConnectConfig } from '../ipc/validators/mcp-stdio';
import { ensureStdioConsent, type StdioLaunchSpec } from '../security/mcp-stdio-consent';
import { buildStdioChildEnv } from '../security/mcp-stdio-policy';
import { unwrapSecretValueMain } from '../security/secret-handle-store';
import { connectMcpSdkClient, type McpSdkClient } from './mcp-sdk-client';
import {
  createStderrForwarder,
  liveStdioChildCount,
  type TrackedChild,
  terminateStdioChild,
  trackStdioChild,
} from './mcp-stdio-session';

/** npx/uvx may download a package on first launch; allow for it. */
export const STDIO_CONNECT_TIMEOUT_MS = 120_000;

export interface StdioSessionLike {
  disposed: boolean;
  client?: McpSdkClient;
  onDispose?: () => void;
}

export interface ConnectStdioOptions {
  config: McpStdioConnectConfig;
  owner: WebContents;
  maxConcurrentChildren: number;
  /** The handler's claim for this connection is still the live one. */
  isCurrent: () => boolean;
  session: StdioSessionLike;
  /** Attach the session to the claim so renderer-destroyed/disconnect can dispose it. */
  registerPending: () => void;
  emit: (prefix: string, payload?: unknown) => void;
  /** The committed session in the registry is this one. */
  isLive: () => boolean;
  removeLive: () => void;
  log: Logger;
  // Test seams.
  connect?: typeof connectMcpSdkClient;
  consent?: typeof ensureStdioConsent;
  resolveSecret?: (value: unknown) => string | undefined;
  timeoutMs?: number;
}

export type ConnectStdioResult = { ok: true } | { ok: false; error: string };

function withStderrTail(message: string, tail: string): string {
  return tail ? `${message}\n\nServer stderr:\n${tail}` : message;
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function connectStdioSdkClient(
  options: ConnectStdioOptions
): Promise<ConnectStdioResult> {
  const { config, session, log } = options;
  const connect = options.connect ?? connectMcpSdkClient;
  const consent = options.consent ?? ensureStdioConsent;
  const resolveSecret = options.resolveSecret ?? unwrapSecretValueMain;
  const timeoutMs = options.timeoutMs ?? STDIO_CONNECT_TIMEOUT_MS;

  // The effective cwd is part of what the user approves, so resolve the
  // default here (never inherit Electron's own, platform-dependent cwd).
  const cwd = config.cwd ?? os.homedir();
  if (!(await isDirectory(cwd))) {
    return { ok: false, error: `Working directory does not exist: ${cwd}` };
  }
  if (liveStdioChildCount() >= options.maxConcurrentChildren) {
    return { ok: false, error: 'Too many running stdio MCP servers.' };
  }

  const spec: StdioLaunchSpec = {
    command: config.command,
    args: config.args,
    cwd,
    env: config.env ?? {},
  };
  const decision = await consent(spec, options.owner);
  if (decision === 'denied') {
    return { ok: false, error: 'Starting the local MCP server was not approved.' };
  }
  // The renderer may have disconnected/been destroyed while the dialog was open.
  if (!options.isCurrent()) return { ok: false, error: 'Not connected' };

  const userEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(spec.env)) {
    const plain = resolveSecret(value);
    if (plain === undefined) {
      return { ok: false, error: `Secret for environment variable ${name} is unavailable` };
    }
    userEnv[name] = plain;
  }

  const stderr = createStderrForwarder((text) => options.emit(EVENT_PREFIX.mcp.stderr, { text }));
  let child: TrackedChild | undefined;
  const killChild = () => {
    if (child) void terminateStdioChild(child);
  };
  session.onDispose = killChild;

  const teardown = () => {
    if (!session.disposed) {
      session.disposed = true;
      void session.client?.close().catch(() => {});
    }
    killChild();
  };

  options.registerPending();
  if (!options.isCurrent()) {
    teardown();
    return { ok: false, error: 'Not connected' };
  }

  const events = {
    onNotification: async (notification: unknown) => {
      if (session.disposed) return;
      options.emit(EVENT_PREFIX.mcp.notification, notification);
    },
    onError: (err: Error) => {
      if (session.disposed) return;
      const message = errorMessage(err);
      log.warn('stdio client error', { connectionId: config.connectionId, error: message });
      options.emit(EVENT_PREFIX.mcp.error, { message });
    },
    onClose: () => {
      if (session.disposed) return;
      session.disposed = true;
      killChild();
      if (options.isLive()) {
        options.removeLive();
        options.emit(EVENT_PREFIX.mcp.close, { reason: 'server process ended' });
      }
    },
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      connect({
        transport: 'stdio',
        stdio: {
          command: config.command,
          args: config.args,
          cwd,
          env: buildStdioChildEnv(userEnv),
          onStderr: (chunk) => stderr.push(chunk),
          onSpawn: (spawned) => {
            child = spawned;
            trackStdioChild(spawned);
            spawned.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
              stderr.push(
                `\n[server process exited${code !== null ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}]\n`
              );
            });
            // Disposed between spawn() and the 'spawn' event: kill right away.
            if (session.disposed) killChild();
          },
        },
        events,
        onClientCreated: (client) => {
          session.client = client;
        },
      }).then((client) => {
        session.client = client;
      }),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Connection timeout after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } catch (err) {
    teardown();
    const message = errorMessage(err);
    log.warn('stdio connect failed', { connectionId: config.connectionId, error: message });
    return { ok: false, error: withStderrTail(message, stderr.tail()) };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  if (session.disposed) {
    teardown();
    return {
      ok: false,
      error: withStderrTail('Connection closed during initialization', stderr.tail()),
    };
  }
  return { ok: true };
}
