// @vitest-environment node
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';
import { IPC } from '../../shared/channels';

// The consent mirror is a plain JSON file in userData — point userData at a
// throwaway temp dir and let the real fs handle the round-trip.
const tmpDir = path.join(os.tmpdir(), 'restura-consent-test');

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => tmpDir },
}));

// Spy on the Sentry gate without loading the real SDK.
vi.mock('../lifecycle/sentry', () => ({ setSentryEnabled: vi.fn() }));

import { readConsentSync, registerTelemetryConsentIPC } from '../lifecycle/telemetry-consent';
import { ipcMain } from 'electron';
import { setSentryEnabled } from '../lifecycle/sentry';

const handleMock = ipcMain.handle as unknown as Mock;
const setEnabledMock = setSentryEnabled as unknown as Mock;

const trustedEvent = { senderFrame: { url: 'http://localhost:5173' } } as never;

function getRegisteredHandler(): (event: unknown, enabled: unknown) => Promise<{ ok: true }> {
  const call = handleMock.mock.calls.find((c) => c[0] === IPC.telemetry.setConsent);
  if (!call) throw new Error('handler not registered');
  return call[1];
}

describe('telemetry-consent', () => {
  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    handleMock.mockClear();
    setEnabledMock.mockClear();
  });

  it('readConsentSync defaults to true (opt-out) when no file exists', () => {
    expect(readConsentSync()).toBe(true);
  });

  it('persists consent and flips the Sentry gate, round-tripping through readConsentSync', async () => {
    registerTelemetryConsentIPC();
    const handler = getRegisteredHandler();

    await handler(trustedEvent, true);
    expect(setEnabledMock).toHaveBeenCalledWith(true);
    expect(readConsentSync()).toBe(true);

    await handler(trustedEvent, false);
    expect(setEnabledMock).toHaveBeenCalledWith(false);
    expect(readConsentSync()).toBe(false);
  });

  it('rejects a non-boolean payload', async () => {
    registerTelemetryConsentIPC();
    const handler = getRegisteredHandler();
    await expect(handler(trustedEvent, 'yes')).rejects.toThrow();
    expect(setEnabledMock).not.toHaveBeenCalled();
  });

  it('rejects an untrusted sender frame', async () => {
    registerTelemetryConsentIPC();
    const handler = getRegisteredHandler();
    const untrusted = { senderFrame: { url: 'https://evil.example' } } as never;
    await expect(handler(untrusted, true)).rejects.toThrow(/untrusted frame/);
  });
});
