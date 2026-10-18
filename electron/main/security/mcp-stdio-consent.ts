/**
 * Consent gate for the MCP stdio transport (#854, ADR 0030).
 *
 * Before main spawns ANY local process for a stdio MCP server it asks the
 * user, through a native `dialog.showMessageBox` owned by main, to approve
 * the exact launch: the resolved program path, every argument, the working
 * directory, and every environment variable. The renderer has no say in the
 * outcome:
 *
 *  - The consent key is an HMAC-SHA256 over the canonical launch spec, keyed
 *    by a random secret that only main can read: it is stored sealed with
 *    Electron `safeStorage` (OS keychain). A renderer that can compute the
 *    canonical spec still cannot compute a valid key, so writing entries into
 *    the store file cannot pre-approve anything; entries that are not valid
 *    MACs of a real launch simply never match. If `safeStorage` is
 *    unavailable, approvals are never remembered (every launch prompts).
 *  - The IPC schema is `.strict()`, so a payload cannot carry an approval
 *    flag, and the renderer-facing fs channels cannot reach main's store or
 *    key files (see storage/file-operations.ts).
 *  - Imported collections, mcp.json imports and agent surfaces all flow
 *    through the same `mcp:connect` path and get the same prompt.
 *
 * Any change to the program, args, cwd or env (names AND values; for a
 * secret handle, its id and a digest of its current value) is a new key and a
 * new prompt.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSecretFieldName } from '@shared/secrets/key-value-redaction';
import { app, BrowserWindow, dialog, safeStorage, type WebContents } from 'electron';
import { isExecutionSensitiveEnvName } from './mcp-stdio-policy';

// electron-store v9+ is ESM-only; require() returns the module namespace under Node 22+
const Store = require('electron-store').default;

/** One env entry as main sees it at consent time (handles already looked up). */
export type StdioConsentEnvValue =
  | { kind: 'plain'; value: string }
  | {
      kind: 'handle';
      id: string;
      /** Label stored with the handle in main (never the renderer's copy). */
      label?: string;
      /** SHA-256 of the handle's current plaintext: rotating it re-prompts. */
      digest: string;
    };

/** The exact launch a consent decision covers. */
export interface StdioLaunchSpec {
  /** What the user typed (display only). */
  command: string;
  /** Absolute path main resolved and will spawn. Part of the key. */
  resolvedPath: string;
  /** Windows: the target is a .cmd/.bat run through cmd.exe. */
  viaCmd: boolean;
  args: readonly string[];
  /** The EFFECTIVE cwd. */
  cwd: string;
  env: Readonly<Record<string, StdioConsentEnvValue>>;
}

interface ConsentRecord {
  approvedAt: number;
  /** Display-only: the resolved program, for a future "manage approvals" list. */
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
const CONSENT_KEY_VERSION = 2;
const MAC_KEY_FILE = '.mcp-stdio-consent-key';
/** Longest argument/value shown verbatim; longer ones are cut and block "Always allow". */
export const CONSENT_DISPLAY_MAX_CHARS = 512;
/** Overall cap on the dialog detail; beyond it entries are elided and "Always allow" is off. */
export const CONSENT_DETAIL_MAX_CHARS = 8 * 1024;

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

// ---------------------------------------------------------------------------
// MAC key: random, sealed with safeStorage, readable only by main.
// ---------------------------------------------------------------------------

type MacKeyProvider = () => Buffer | null;

function safeStorageUsable(): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    // Linux without a keyring falls back to a hard-coded password; that is
    // not a secret, so treat it as unavailable and fail closed.
    const backend = (
      safeStorage as unknown as { getSelectedStorageBackend?: () => string }
    ).getSelectedStorageBackend?.();
    return backend !== 'basic_text';
  } catch {
    return false;
  }
}

const defaultMacKeyProvider: MacKeyProvider = () => {
  if (!safeStorageUsable()) return null;
  const file = path.join(app.getPath('userData'), MAC_KEY_FILE);
  try {
    const sealed = fs.readFileSync(file);
    const hex = safeStorage.decryptString(sealed);
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  } catch {
    // Missing, unreadable or undecryptable: mint a new key below. Previous
    // approvals then no longer verify, which fails closed (prompts again).
  }
  try {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(file, safeStorage.encryptString(key.toString('hex')), { mode: 0o600 });
    return key;
  } catch {
    return null;
  }
};

let macKeyProvider: MacKeyProvider = defaultMacKeyProvider;
let cachedMacKey: Buffer | null | undefined;

/** Test-only seam: inject the MAC key source (null = safeStorage unavailable). */
export function __setStdioConsentMacKeyProviderForTests(provider: MacKeyProvider | null): void {
  macKeyProvider = provider ?? defaultMacKeyProvider;
  cachedMacKey = undefined;
}

function getMacKey(): Buffer | null {
  if (cachedMacKey === undefined) cachedMacKey = macKeyProvider();
  return cachedMacKey;
}

/** Whether "Always allow" can be offered (approvals are verifiable). */
export function canRememberStdioConsent(): boolean {
  return getMacKey() !== null;
}

function envFingerprint(value: StdioConsentEnvValue): string {
  return value.kind === 'plain' ? `v:${value.value}` : `h:${value.id}:${value.digest}`;
}

/** Canonical, order-insensitive (for env) serialisation. Args stay ordered. */
export function canonicalStdioLaunch(spec: StdioLaunchSpec): string {
  const env = Object.keys(spec.env)
    .sort()
    .map((name) => [name, envFingerprint(spec.env[name]!)]);
  return JSON.stringify({
    v: CONSENT_KEY_VERSION,
    path: spec.resolvedPath,
    viaCmd: spec.viaCmd,
    args: [...spec.args],
    cwd: spec.cwd,
    env,
  });
}

/** HMAC consent key, or null when no main-only MAC key is available. */
export function stdioConsentKey(spec: StdioLaunchSpec): string | null {
  const macKey = getMacKey();
  if (!macKey) return null;
  return crypto.createHmac('sha256', macKey).update(canonicalStdioLaunch(spec)).digest('hex');
}

export function hasStdioConsent(spec: StdioLaunchSpec): boolean {
  const key = stdioConsentKey(spec);
  return key !== null && getStore().has(key);
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
  store.set(key, { approvedAt: Date.now(), command: spec.resolvedPath.slice(0, 512) });
}

// ---------------------------------------------------------------------------
// Dialog text
// ---------------------------------------------------------------------------

/** JSON-quote, cutting long text with an explicit marker. */
function quoted(text: string): { text: string; cut: boolean } {
  if (text.length <= CONSENT_DISPLAY_MAX_CHARS) return { text: JSON.stringify(text), cut: false };
  const more = text.length - CONSENT_DISPLAY_MAX_CHARS;
  return {
    text: `${JSON.stringify(text.slice(0, CONSENT_DISPLAY_MAX_CHARS))} … (${more} more characters not shown)`,
    cut: true,
  };
}

/** Plain values are shown in full unless the NAME looks like a credential. */
function hidesValue(name: string): boolean {
  return isSecretFieldName(name) && !isExecutionSensitiveEnvName(name);
}

export interface StdioConsentDetail {
  detail: string;
  /** Something was cut for display, so "Always allow" is not offered. */
  truncated: boolean;
}

export function formatStdioConsentDetail(spec: StdioLaunchSpec): StdioConsentDetail {
  let truncated = false;
  const show = (text: string) => {
    const q = quoted(text);
    if (q.cut) truncated = true;
    return q.text;
  };
  const head = [
    'Restura will start this program on your computer with your user privileges.',
    'Only allow programs you trust — an MCP server can read and change your files.',
    '',
    `Program: ${show(spec.resolvedPath)}`,
  ];
  if (spec.command !== spec.resolvedPath) head.push(`  (requested as ${show(spec.command)})`);
  if (spec.viaCmd) {
    head.push('  Runs through cmd.exe (Windows command script).');
  }
  const entries: string[] = [
    spec.args.length === 0 ? 'Arguments: (none)' : `Arguments (${spec.args.length}):`,
    ...spec.args.map((arg, i) => `  [${i}] ${show(arg)}`),
    `Working directory: ${show(spec.cwd)}`,
  ];
  const envNames = Object.keys(spec.env).sort();
  entries.push(envNames.length === 0 ? 'Extra environment: (none)' : 'Extra environment:');
  for (const name of envNames) {
    const value = spec.env[name]!;
    if (value.kind === 'handle') {
      entries.push(
        `  ${name} = <from the secret store${value.label ? `: ${show(value.label)}` : ''}>`
      );
    } else if (hidesValue(name)) {
      entries.push(`  ${name} = <${value.value.length} characters, hidden>`);
    } else {
      entries.push(`  ${name} = ${show(value.value)}`);
    }
  }
  const tail = [
    '',
    'The program receives only these variables plus a minimal safe set (PATH, HOME, locale).',
  ];

  // Overall cap: keep whole lines while they fit, then say how many were elided.
  const lines = [...head];
  let size = head.join('\n').length;
  for (let i = 0; i < entries.length; i++) {
    const line = entries[i]!;
    if (size + line.length + 1 > CONSENT_DETAIL_MAX_CHARS) {
      lines.push(`… ${entries.length - i} more lines not shown`);
      truncated = true;
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  tail.push(
    truncated
      ? 'Part of this command line is not shown, so it can only be allowed once.'
      : '"Always allow" remembers this exact command line; any change asks again.'
  );
  return { detail: [...lines, ...tail].join('\n'), truncated };
}

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

export type StdioConsentDecision = 'always' | 'once' | 'denied';

// One prompt at a time (a misbehaving renderer cannot stack dialogs).
// Concurrent requests share a prompt only when they come from the same
// requester for the same launch; a different connection asking for the same
// launch gets its own decision ("Allow once" is never shared).
let promptChain: Promise<unknown> = Promise.resolve();
const inFlight = new Map<string, Promise<StdioConsentDecision>>();

async function promptUser(
  spec: StdioLaunchSpec,
  owner: WebContents | undefined,
  allowAlways: boolean
): Promise<StdioConsentDecision> {
  const window = owner && !owner.isDestroyed() ? BrowserWindow.fromWebContents(owner) : null;
  const { detail, truncated } = formatStdioConsentDetail(spec);
  const offerAlways = allowAlways && !truncated;
  const buttons = offerAlways ? ['Cancel', 'Allow once', 'Always allow'] : ['Cancel', 'Allow once'];
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Start local MCP server?',
    message: 'Allow Restura to start a local MCP server process?',
    detail: allowAlways
      ? detail
      : `${detail}\nApprovals can't be remembered because the OS keychain is unavailable.`,
    buttons,
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  if (result.response === 2 && offerAlways) return 'always';
  if (result.response === 1) return 'once';
  return 'denied';
}

/**
 * Resolve consent for a launch: a verified persisted approval short-circuits;
 * otherwise the native dialog decides. Never throws for a user "Cancel" —
 * returns `'denied'` so the handler can report it.
 */
export async function ensureStdioConsent(
  spec: StdioLaunchSpec,
  owner?: WebContents,
  requester = 'default'
): Promise<StdioConsentDecision> {
  const key = stdioConsentKey(spec);
  if (key !== null && getStore().has(key)) return 'always';

  const flightKey = `${key ?? canonicalStdioLaunch(spec)}|${requester}`;
  const pending = inFlight.get(flightKey);
  if (pending) return pending;

  const decision = promptChain
    .catch(() => undefined)
    .then(async () => {
      // A prompt that just finished may have persisted this exact launch.
      if (key !== null && getStore().has(key)) return 'always' as const;
      const answer = await promptUser(spec, owner, key !== null);
      if (answer === 'always' && key !== null) persistApproval(key, spec);
      return answer;
    });
  promptChain = decision;
  inFlight.set(flightKey, decision);
  try {
    return await decision;
  } finally {
    inFlight.delete(flightKey);
  }
}
