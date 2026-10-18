/**
 * Consent gate for the MCP stdio transport (#854, ADR 0030).
 *
 * Before main spawns ANY local process for a stdio MCP server it asks the
 * user — through a native `dialog.showMessageBox` owned by main — to approve
 * the exact launch: command, every argument, working directory, and every
 * environment variable. The renderer has no say in the outcome:
 *
 *  - The consent key is a SHA-256 over the canonical launch spec, computed
 *    here from the already-validated IPC payload. Nothing in the payload can
 *    name, pre-compute, or pre-approve a key (the IPC schema is `.strict()`,
 *    so even an `approved: true` field is rejected outright).
 *  - "Always allow" decisions are persisted in a main-only electron-store.
 *    There is no IPC that writes to it; the renderer can only REVOKE (clear)
 *    approvals, which can never widen privilege.
 *  - Imported collections, mcp.json imports, and agent/MCP-server surfaces
 *    all flow through the same `mcp:connect` path, so none of them can skip
 *    the prompt for a launch the user has not approved on this machine.
 *
 * Any change to command, args, cwd, or env (names AND values — a changed
 * `NPM_CONFIG_REGISTRY` or `NODE_OPTIONS` is a different program) produces a
 * new key and a new prompt. Secret-handle env values contribute their handle
 * id, so rotating the secret behind a handle does not re-prompt.
 */

import * as crypto from 'node:crypto';
import { BrowserWindow, dialog, type WebContents } from 'electron';
import type { McpStdioEnvValue } from '../ipc/validators/mcp-stdio';
import { isExecutionSensitiveEnvName } from './mcp-stdio-policy';

// electron-store v9+ is ESM-only; require() returns the module namespace under Node 22+
const Store = require('electron-store').default;

/** The exact launch a consent decision covers. `cwd` is the EFFECTIVE cwd. */
export interface StdioLaunchSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, McpStdioEnvValue>>;
}

interface ConsentRecord {
  approvedAt: number;
  /** Display-only: the command, for a future "manage approvals" list. */
  command: string;
}

export interface ConsentStoreShape {
  get: (key: string) => ConsentRecord | undefined;
  set: (key: string, value: ConsentRecord) => void;
  has: (key: string) => boolean;
  clear: () => void;
  store: Record<string, ConsentRecord>;
}

const MAX_PERSISTED_APPROVALS = 500;
const CONSENT_KEY_VERSION = 1;

let storeInstance: ConsentStoreShape | null = null;

/** Test-only seam (vi.mock cannot intercept the lazy CJS electron-store require). */
export function __setStdioConsentStoreForTests(store: ConsentStoreShape | null): void {
  storeInstance = store;
}

function getStore(): ConsentStoreShape {
  if (storeInstance) return storeInstance;
  storeInstance = new Store({
    name: 'restura-mcp-stdio-consent',
    clearInvalidConfig: true,
  }) as ConsentStoreShape;
  return storeInstance;
}

function envFingerprint(value: McpStdioEnvValue): string {
  if (typeof value === 'string') return `v:${value}`;
  if (value.kind === 'inline') return `v:${value.value}`;
  return `h:${value.id}`;
}

/**
 * Canonical, order-insensitive (for env) hash of a launch spec. Args stay
 * ordered — argv order is semantic. Keys are hex SHA-256 with a version tag
 * so a future canonicalisation change cannot collide with old approvals.
 */
export function stdioConsentKey(spec: StdioLaunchSpec): string {
  const env = Object.keys(spec.env)
    .sort()
    .map((name) => [name, envFingerprint(spec.env[name]!)]);
  const canonical = JSON.stringify({
    v: CONSENT_KEY_VERSION,
    command: spec.command,
    args: [...spec.args],
    cwd: spec.cwd,
    env,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function hasStdioConsent(spec: StdioLaunchSpec): boolean {
  return getStore().has(stdioConsentKey(spec));
}

/** Remove every persisted approval. Safe to expose to the renderer: it only narrows. */
export function revokeAllStdioConsents(): number {
  const store = getStore();
  const count = Object.keys(store.store ?? {}).length;
  store.clear();
  return count;
}

function persistApproval(key: string, spec: StdioLaunchSpec): void {
  const store = getStore();
  const entries = Object.entries(store.store ?? {});
  if (entries.length >= MAX_PERSISTED_APPROVALS) {
    // Evict the oldest approvals; re-approval is one prompt away.
    const keep = entries
      .sort(([, a], [, b]) => b.approvedAt - a.approvedAt)
      .slice(0, MAX_PERSISTED_APPROVALS - 1);
    store.clear();
    for (const [k, record] of keep) store.set(k, record);
  }
  store.set(key, { approvedAt: Date.now(), command: spec.command.slice(0, 512) });
}

function describeEnv(spec: StdioLaunchSpec): string[] {
  return Object.keys(spec.env)
    .sort()
    .map((name) => {
      const value = spec.env[name]!;
      if (typeof value === 'object' && value.kind === 'handle') {
        return `  ${name} = <secret handle${value.label ? `: ${value.label}` : ''}>`;
      }
      const plain = typeof value === 'string' ? value : value.value;
      return isExecutionSensitiveEnvName(name)
        ? `  ${name} = ${JSON.stringify(plain)}`
        : `  ${name} = <${plain.length} characters, hidden>`;
    });
}

/** The full dialog detail. Every argument is shown, JSON-quoted (so spaces/quotes are unambiguous). */
export function formatStdioConsentDetail(spec: StdioLaunchSpec): string {
  const lines = [
    'Restura will start this program on your computer with your user privileges.',
    'Only allow programs you trust — an MCP server can read and change your files.',
    '',
    `Command: ${JSON.stringify(spec.command)}`,
    spec.args.length === 0 ? 'Arguments: (none)' : `Arguments (${spec.args.length}):`,
    ...spec.args.map((arg, i) => `  [${i}] ${JSON.stringify(arg)}`),
    `Working directory: ${JSON.stringify(spec.cwd)}`,
  ];
  const env = describeEnv(spec);
  lines.push(env.length === 0 ? 'Extra environment: (none)' : 'Extra environment:', ...env);
  lines.push(
    '',
    'The program receives only these variables plus a minimal safe set (PATH, HOME, locale).',
    '"Always allow" remembers this exact command line; any change asks again.'
  );
  return lines.join('\n');
}

export type StdioConsentDecision = 'always' | 'once' | 'denied';

const BUTTONS = ['Cancel', 'Allow once', 'Always allow'] as const;

// One prompt at a time (a misbehaving renderer cannot stack dialogs), and
// concurrent requests for the same launch share the single in-flight prompt.
let promptChain: Promise<unknown> = Promise.resolve();
const inFlight = new Map<string, Promise<StdioConsentDecision>>();

async function promptUser(
  spec: StdioLaunchSpec,
  owner: WebContents | undefined
): Promise<StdioConsentDecision> {
  const window = owner && !owner.isDestroyed() ? BrowserWindow.fromWebContents(owner) : null;
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Start local MCP server?',
    message: 'Allow Restura to start a local MCP server process?',
    detail: formatStdioConsentDetail(spec),
    buttons: [...BUTTONS],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  if (result.response === 2) return 'always';
  if (result.response === 1) return 'once';
  return 'denied';
}

/**
 * Resolve consent for a launch: a persisted "always" approval short-circuits;
 * otherwise the native dialog decides. Never throws for a user "Cancel" —
 * returns `'denied'` so the handler can report it.
 */
export async function ensureStdioConsent(
  spec: StdioLaunchSpec,
  owner?: WebContents
): Promise<StdioConsentDecision> {
  const key = stdioConsentKey(spec);
  if (getStore().has(key)) return 'always';

  const pending = inFlight.get(key);
  if (pending) return pending;

  const decision = promptChain
    .catch(() => undefined)
    .then(async () => {
      // A concurrent prompt may have just persisted this exact launch.
      if (getStore().has(key)) return 'always' as const;
      const answer = await promptUser(spec, owner);
      if (answer === 'always') persistApproval(key, spec);
      return answer;
    });
  promptChain = decision;
  inFlight.set(key, decision);
  try {
    return await decision;
  } finally {
    inFlight.delete(key);
  }
}
