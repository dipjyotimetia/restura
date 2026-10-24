// @vitest-environment node
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as IpcUtils from '../ipc/ipc-utils';

/**
 * #906 safety property: an imported stdio server is NOT pre-approved. The
 * import produces a draft; connecting it goes through the real `mcp:connect`
 * handler and the main-owned consent gate, which prompts on first launch.
 */

const mockHandle = vi.hoisted(() => vi.fn());
const mockEmitTo = vi.hoisted(() => vi.fn());
const mockShowMessageBox = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
  dialog: { showMessageBox: mockShowMessageBox },
  BrowserWindow: { fromWebContents: () => null },
}));
vi.mock('../ipc/ipc-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof IpcUtils>();
  return { ...actual, emitTo: mockEmitTo };
});

import { parseMcpConfigText } from '@shared/mcp-import/mcp-config-parser';
import { registerMcpHandlerIPC, stopMcpCleanup } from '../handlers/mcp-handler';
import { commitEntries } from '../handlers/mcp-import-handler';
import { liveStdioChildCount } from '../handlers/mcp-stdio-session';
import {
  __setStdioConsentMacKeyProviderForTests,
  __setStdioConsentStoreForTests,
  type ConsentStoreShape,
} from '../security/mcp-stdio-consent';
import { __setSecretStoreForTests, type SecretStoreShape } from '../security/secret-handle-store';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<Record<string, unknown>>;

const FIXTURE = path.resolve(__dirname, '../../../e2e-electron/fixtures/mcp-stdio-server.mjs');
const CANCEL = 0;
const ONCE = 1;

const registered = new Map<string, IpcHandler>();

function memoryConsentStore(): ConsentStoreShape {
  const data: Record<string, { approvedAt: number; command: string }> = {};
  return {
    get: (k) => data[k],
    set: (k, v) => {
      data[k] = v;
    },
    has: (k) => k in data,
    clear: () => {
      for (const k of Object.keys(data)) delete data[k];
    },
    get store() {
      return data;
    },
  };
}

function memorySecretStore(): SecretStoreShape {
  const data: Record<string, { value: string; label?: string; createdAt: number }> = {};
  return {
    get: (k) => data[k],
    set: (k, v) => {
      data[k] = v;
    },
    delete: (k) => {
      delete data[k];
    },
    clear: () => {},
    has: (k) => k in data,
    get store() {
      return data;
    },
  } as SecretStoreShape;
}

function makeEvent() {
  const sender = Object.assign(new EventEmitter(), { id: 4242, isDestroyed: () => false });
  return { sender, senderFrame: { url: 'file:///app/dist/web/index.html' } };
}

/** What the renderer sends for an imported draft (mirrors buildStdioLaunch). */
function connectPayloadFor(draft: ReturnType<typeof commitEntries>['drafts'][number]) {
  const env: Record<string, unknown> = {};
  for (const row of draft.stdio?.env ?? []) env[row.key] = row.secretRef ?? row.value;
  return {
    connectionId: 'imported-1',
    transport: 'stdio',
    command: draft.stdio?.command,
    args: draft.stdio?.args,
    cwd: draft.stdio?.cwd,
    env,
  };
}

describe('imported stdio entries still hit the consent gate (#906)', () => {
  let tmp: string;
  let secrets: SecretStoreShape;

  beforeAll(() => {
    registerMcpHandlerIPC();
    for (const [channel, handler] of mockHandle.mock.calls) {
      registered.set(channel as string, handler as IpcHandler);
    }
  });
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'mcp-import-consent-'));
    secrets = memorySecretStore();
    __setSecretStoreForTests(secrets);
    __setStdioConsentStoreForTests(memoryConsentStore());
    __setStdioConsentMacKeyProviderForTests(() => Buffer.alloc(32, 9));
    mockShowMessageBox.mockReset();
  });
  afterEach(async () => {
    await stopMcpCleanup();
    rmSync(tmp, { recursive: true, force: true });
  });
  afterAll(() => {
    __setStdioConsentStoreForTests(null);
    __setStdioConsentMacKeyProviderForTests(null);
    __setSecretStoreForTests(null);
  });

  function importDraft(marker: string) {
    const cfg = parseMcpConfigText(
      JSON.stringify({
        mcpServers: {
          evil: {
            command: process.execPath,
            args: [FIXTURE],
            cwd: path.dirname(FIXTURE),
            env: { MCP_STDIO_FIXTURE_MARKER: marker, API_TOKEN: 'super-secret-plaintext' },
          },
        },
      })
    );
    const entries = new Map(cfg.entries.map((e) => [`0.${e.key}`, e]));
    const { drafts, skipped } = commitEntries(entries, ['0.0']);
    expect(skipped).toEqual([]);
    return drafts[0]!;
  }

  it('prompts on first launch, and a refusal never spawns', async () => {
    const marker = path.join(tmp, 'spawned.txt');
    const draft = importDraft(marker);
    mockShowMessageBox.mockResolvedValue({ response: CANCEL, checkboxChecked: false });

    const res = await registered.get('mcp:connect')!(makeEvent(), connectPayloadFor(draft));

    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
    expect(res.success).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(liveStdioChildCount()).toBe(0);
    // The dialog never carries the plaintext of the handle-backed secret.
    const options = mockShowMessageBox.mock.calls[0]?.[0] as { detail: string };
    expect(options.detail).not.toContain('super-secret-plaintext');
    expect(options.detail).toContain('API_TOKEN');
  });

  it('only "Allow once" lets the imported entry run', async () => {
    const draft = importDraft(path.join(tmp, 'ran.txt'));
    mockShowMessageBox.mockResolvedValue({ response: ONCE, checkboxChecked: false });
    const event = makeEvent();
    const res = await registered.get('mcp:connect')!(event, connectPayloadFor(draft));
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
    expect(res.success).toBe(true);
    await registered.get('mcp:disconnect')!(event, { connectionId: 'imported-1' });
    // "Allow once" is not remembered: the next launch prompts again.
    mockShowMessageBox.mockResolvedValue({ response: CANCEL, checkboxChecked: false });
    await registered.get('mcp:connect')!(event, connectPayloadFor(draft));
    expect(mockShowMessageBox).toHaveBeenCalledTimes(2);
  });

  it('an import draft cannot carry an approval into mcp:connect', async () => {
    const draft = importDraft(path.join(tmp, 'x.txt'));
    await expect(
      registered.get('mcp:connect')!(makeEvent(), {
        ...connectPayloadFor(draft),
        approved: true,
      })
    ).rejects.toThrow(/Invalid IPC payload/);
    expect(mockShowMessageBox).not.toHaveBeenCalled();
  });
});
