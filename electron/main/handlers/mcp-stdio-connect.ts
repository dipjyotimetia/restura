/**
 * Connect flow for the desktop-only MCP stdio transport (#854, ADR 0030).
 *
 * Kept out of mcp-handler.ts so the security-relevant ordering is readable in
 * one place:
 *
 *   reserve a process slot (synchronously)
 *   → look up secret handles in main (unknown ids refused before prompting)
 *   → build the allowlisted env → resolve the command on PATH (never cwd)
 *   → Windows .cmd/.bat argument rules
 *   → consent (native dialog owned by main)
 *   → claim + slot still valid → cwd exists → spawn the resolved path (no shell)
 *   → handshake.
 *
 * The working directory is not touched until the user has approved the
 * launch. The handler owns claims and the session registry; this module owns
 * the process.
 */

import * as crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import type { Logger } from '@shared/runtime/logger';
import type { WebContents } from 'electron';
import { EVENT_PREFIX } from '../../shared/channels';
import { errorMessage } from '../ipc/ipc-utils';
import type { McpStdioConnectConfig } from '../ipc/validators/mcp-stdio';
import {
  ensureStdioConsent,
  type StdioConsentEnvValue,
  type StdioLaunchSpec,
} from '../security/mcp-stdio-consent';
import { buildStdioChildEnv, cmdShimArgError } from '../security/mcp-stdio-policy';
import { resolveStdioCommand } from '../security/mcp-stdio-resolve';
import { describeSecretHandle, resolveSecretHandle } from '../security/secret-handle-store';
import {
  connectMcpSdkClient,
  type McpSdkClient,
  type McpSdkClientRequestHandlers,
} from './mcp-sdk-client';
import {
  createStderrForwarder,
  liveStdioChildCount,
  type TrackedChild,
  terminateStdioChild,
  trackStdioChild,
} from './mcp-stdio-session';

/** npx/uvx may download a package on first launch; allow for it. */
export const STDIO_CONNECT_TIMEOUT_MS = 120_000;

/** Server→client request bridge (see mcp-client-requests.ts) bound to the session's owner. */
export interface StdioClientRequestBridge extends McpSdkClientRequestHandlers {
  attachClient(client: McpSdkClient): void;
  dispose(): void;
}

export interface StdioSessionLike {
  disposed: boolean;
  client?: McpSdkClient;
  onDispose?: () => void;
  /** When set, the client advertises roots/elicitation/sampling and routes them here. */
  clientRequests?: StdioClientRequestBridge;
}

export interface SecretHandleLookup {
  describe: (id: string) => { label?: string } | undefined;
  resolve: (id: string) => string | undefined;
}

export interface ConnectStdioOptions {
  config: McpStdioConnectConfig;
  owner: WebContents;
  /** Identifies the requesting connection, so an "Allow once" is never shared. */
  requester: string;
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
  secrets?: SecretHandleLookup;
  resolveCommand?: typeof resolveStdioCommand;
  timeoutMs?: number;
}

export type ConnectStdioResult = { ok: true } | { ok: false; error: string };

const defaultSecrets: SecretHandleLookup = {
  describe: describeSecretHandle,
  resolve: resolveSecretHandle,
};

// Slots for launches that are past the cap check but have not spawned yet.
// Reserved synchronously so parallel connects cannot all pass the cap while
// their consent dialogs are open; released when the child is tracked as live
// (so it is never counted twice) or when the attempt ends.
let reservedSlots = 0;

/** Test-only: pending (not yet spawned) stdio launches. */
export function reservedStdioSlotCount(): number {
  return reservedSlots;
}

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
  if (reservedSlots + liveStdioChildCount() >= options.maxConcurrentChildren) {
    return { ok: false, error: 'Too many running stdio MCP servers.' };
  }
  reservedSlots += 1;
  let slotHeld = true;
  const releaseSlot = () => {
    if (!slotHeld) return;
    slotHeld = false;
    reservedSlots -= 1;
  };
  try {
    return await connectWithSlot(options, releaseSlot);
  } finally {
    releaseSlot();
  }
}

async function connectWithSlot(
  options: ConnectStdioOptions,
  releaseSlot: () => void
): Promise<ConnectStdioResult> {
  const { config, session, log } = options;
  const connect = options.connect ?? connectMcpSdkClient;
  const consent = options.consent ?? ensureStdioConsent;
  const secrets = options.secrets ?? defaultSecrets;
  const resolveCommand = options.resolveCommand ?? resolveStdioCommand;
  const timeoutMs = options.timeoutMs ?? STDIO_CONNECT_TIMEOUT_MS;

  // Secrets: plaintext stays in main; consent sees the handle id, the label
  // stored WITH the handle, and a digest of the current value.
  const userEnv: Record<string, string> = {};
  const consentEnv: Record<string, StdioConsentEnvValue> = {};
  for (const [name, value] of Object.entries(config.env ?? {})) {
    if (typeof value === 'string' || value.kind === 'inline') {
      const plain = typeof value === 'string' ? value : value.value;
      userEnv[name] = plain;
      consentEnv[name] = { kind: 'plain', value: plain };
      continue;
    }
    const meta = secrets.describe(value.id);
    const plain = meta ? secrets.resolve(value.id) : undefined;
    if (!meta || plain === undefined) {
      return { ok: false, error: `Secret for environment variable ${name} was not found` };
    }
    userEnv[name] = plain;
    consentEnv[name] = {
      kind: 'handle',
      id: value.id,
      ...(meta.label !== undefined ? { label: meta.label } : {}),
      digest: crypto.createHash('sha256').update(plain).digest('hex'),
    };
  }
  const childEnv = buildStdioChildEnv(userEnv);

  const resolved = await resolveCommand(config.command, childEnv);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  if (resolved.command.viaCmd) {
    const argError = cmdShimArgError(config.args);
    if (argError) return { ok: false, error: argError };
  }

  // The effective cwd is part of what the user approves, so resolve the
  // default here (never inherit Electron's own, platform-dependent cwd).
  const cwd = config.cwd ?? os.homedir();
  const spec: StdioLaunchSpec = {
    command: config.command,
    resolvedPath: resolved.command.path,
    viaCmd: resolved.command.viaCmd,
    args: config.args,
    cwd,
    env: consentEnv,
  };
  const decision = await consent(spec, options.owner, options.requester);
  if (decision === 'denied') {
    return { ok: false, error: 'Starting the local MCP server was not approved.' };
  }
  // The renderer may have disconnected/been destroyed while the dialog was open.
  if (!options.isCurrent()) return { ok: false, error: 'Not connected' };
  if (!(await isDirectory(cwd))) {
    return { ok: false, error: `Working directory does not exist: ${cwd}` };
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
      session.clientRequests?.dispose();
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
      session.clientRequests?.dispose();
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
          // Spawn exactly the file the user approved.
          command: resolved.command.path,
          args: config.args,
          cwd,
          env: childEnv,
          onStderr: (chunk) => stderr.push(chunk),
          onSpawn: (spawned) => {
            child = spawned;
            trackStdioChild(spawned);
            releaseSlot();
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
        ...(session.clientRequests ? { clientRequests: session.clientRequests } : {}),
        onClientCreated: (client) => {
          session.client = client;
          session.clientRequests?.attachClient(client);
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
