import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platformMock = vi.hoisted(() => ({
  platform: 'web' as string,
  electron: undefined as unknown,
}));

vi.mock('../platform', () => ({
  getPlatform: () => platformMock.platform,
  getAppVersion: async () => '9.9.9',
  getElectronAPI: () => platformMock.electron,
}));

import {
  captureBugReportScreenshot,
  collectBugReportDiagnostics,
  copyBugReportScreenshot,
} from '../bug-report-client';

const originalUa = navigator.userAgent;
function setUa(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ua });
}

beforeEach(() => {
  platformMock.platform = 'web';
  platformMock.electron = undefined;
});

afterEach(() => {
  setUa(originalUa);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('collectBugReportDiagnostics', () => {
  it('merges desktop diagnostics with the renderer runtime errors', async () => {
    const getDiagnostics = vi.fn().mockResolvedValue({ appVersion: '1.0.0', platform: 'electron' });
    platformMock.electron = { bugReport: { getDiagnostics } };
    const out = await collectBugReportDiagnostics();
    expect(getDiagnostics).toHaveBeenCalledOnce();
    expect(out).toMatchObject({ appVersion: '1.0.0', platform: 'electron' });
    expect(Array.isArray(out.runtimeErrors)).toBe(true);
  });

  it.each([
    ['darwin', 'macOS'],
    ['win32', 'Windows'],
    ['linux', 'Linux'],
  ])('maps the %s platform to %s', async (platform, expected) => {
    platformMock.platform = platform;
    const out = await collectBugReportDiagnostics();
    expect(out.operatingSystem).toBe(expected);
    expect(out.platform).toBe('web');
    expect(out.appVersion).toBe('9.9.9');
  });

  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/605', 'macOS', 'Safari'],
    ['Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537 Edg/120', 'Windows', 'Microsoft Edge'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:1) Firefox/120', 'Linux', 'Firefox'],
    ['Mozilla/5.0 (X11; Linux) Chrome/120 Safari/537', 'Linux', 'Chrome'],
    ['curl/8', 'Unknown', 'Unknown'],
  ])('falls back to the user agent %s', async (ua, os, browser) => {
    platformMock.platform = 'other';
    setUa(ua);
    const out = await collectBugReportDiagnostics();
    expect(out.operatingSystem).toBe(os);
    expect(out.browser).toBe(browser);
  });
});

describe('captureBugReportScreenshot', () => {
  it('returns the desktop screenshot on success', async () => {
    platformMock.electron = {
      bugReport: { captureScreenshot: async () => ({ ok: true, imageDataUrl: 'data:x' }) },
    };
    await expect(captureBugReportScreenshot()).resolves.toEqual({
      screenshot: { imageDataUrl: 'data:x' },
    });
  });

  it('surfaces a desktop capture failure', async () => {
    platformMock.electron = {
      bugReport: { captureScreenshot: async () => ({ ok: false, error: 'denied' }) },
    };
    await expect(captureBugReportScreenshot()).resolves.toEqual({ error: 'denied' });
  });

  it('reports an unsupported browser', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    const out = await captureBugReportScreenshot();
    expect(out.error).toMatch(/not supported/);
  });

  it('uses a generic message for non-Error rejections', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia: () => Promise.reject('nope') },
    });
    await expect(captureBugReportScreenshot()).resolves.toEqual({
      error: 'Screenshot capture failed.',
    });
  });

  it('fails when the captured screen has no dimensions and still stops the tracks', async () => {
    const stop = vi.fn();
    const stream = {
      getVideoTracks: () => [],
      getTracks: () => [{ stop }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia: vi.fn().mockResolvedValue(stream) },
    });
    // Already-decoded video without requestVideoFrameCallback.
    const video = {
      play: vi.fn().mockResolvedValue(undefined),
      readyState: 4,
      videoWidth: 0,
      videoHeight: 0,
    } as unknown as HTMLVideoElement;
    const original = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
      tag === 'video' ? video : original(tag)) as typeof document.createElement);

    const out = await captureBugReportScreenshot();
    expect(out.error).toBe('The selected screen could not be captured.');
    expect(stop).toHaveBeenCalledOnce();
  });

  it('waits for loadeddata when the video has no current frame yet', async () => {
    const stream = {
      getVideoTracks: () => [],
      getTracks: () => [],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia: vi.fn().mockResolvedValue(stream) },
    });
    let loaded: (() => void) | undefined;
    const video = {
      play: vi.fn().mockResolvedValue(undefined),
      readyState: 0,
      videoWidth: 20,
      videoHeight: 10,
      addEventListener: (_: string, cb: () => void) => {
        loaded = cb;
      },
    } as unknown as HTMLVideoElement;
    const canvas = {
      getContext: () => null,
      toDataURL: () => 'data:image/png;base64,AA==',
    } as unknown as HTMLCanvasElement;
    const original = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
      tag === 'video'
        ? video
        : tag === 'canvas'
          ? canvas
          : original(tag)) as typeof document.createElement);

    const pending = captureBugReportScreenshot();
    await vi.waitFor(() => expect(loaded).toBeDefined());
    loaded?.();
    await expect(pending).resolves.toEqual({
      screenshot: { imageDataUrl: 'data:image/png;base64,AA==' },
    });
  });
});

describe('copyBugReportScreenshot', () => {
  it('delegates to the desktop bridge and throws its error', async () => {
    const copyScreenshot = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'no clipboard' });
    platformMock.electron = { bugReport: { copyScreenshot } };
    await expect(copyBugReportScreenshot('data:a')).resolves.toBeUndefined();
    await expect(copyBugReportScreenshot('data:a')).rejects.toThrow('no clipboard');
  });

  it('rejects when the browser lacks image clipboard support', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    await expect(copyBugReportScreenshot('data:a')).rejects.toThrow(/not supported/);
  });

  it('writes the fetched image to the clipboard', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } });
    class FakeClipboardItem {
      constructor(public items: Record<string, Blob>) {}
    }
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ blob: async () => new Blob(['x'], { type: 'image/png' }) })
    );
    await copyBugReportScreenshot('data:image/png;base64,AA==');
    expect(write).toHaveBeenCalledOnce();
  });
});
