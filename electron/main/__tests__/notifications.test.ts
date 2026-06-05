// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createElectronMock, trustedEvent, getRegisteredHandler } from './helpers/electron-mock';

// Track constructed notifications so we can assert show()/click wiring.
const { notifications } = vi.hoisted(() => ({ notifications: [] as FakeNotification[] }));

interface FakeNotification {
  opts: unknown;
  show: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  fire(event: string): void;
}

vi.mock('electron', () => {
  const base = createElectronMock();
  class NotificationMock {
    static isSupported = vi.fn(() => true);
    handlers: Record<string, () => void> = {};
    show = vi.fn();
    on = vi.fn((e: string, cb: () => void) => {
      this.handlers[e] = cb;
    });
    constructor(public opts: unknown) {
      notifications.push(this as unknown as FakeNotification);
    }
    fire(e: string) {
      this.handlers[e]?.();
    }
  }
  return { ...base, Notification: NotificationMock };
});
vi.mock('fs', () => ({ existsSync: vi.fn(() => false) }));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/channels';
import {
  showNativeNotification,
  registerNotificationIPC,
  notificationRateLimiter,
} from '../notifications';

describe('showNativeNotification', () => {
  beforeEach(() => {
    notifications.length = 0;
  });

  it('constructs and shows a notification with the given title/body', () => {
    showNativeNotification({ title: 'Hi', body: 'There' }, null, true);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.opts).toMatchObject({ title: 'Hi', body: 'There', silent: false });
    expect(notifications[0]!.show).toHaveBeenCalled();
  });

  it('focuses the main window on click when it is alive', () => {
    const win = { isDestroyed: () => false, show: vi.fn(), focus: vi.fn() };
    showNativeNotification({ title: 'a', body: 'b' }, win as never, true);
    notifications[0]!.fire('click');
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
  });

  it('does not touch a destroyed window on click', () => {
    const win = { isDestroyed: () => true, show: vi.fn(), focus: vi.fn() };
    showNativeNotification({ title: 'a', body: 'b' }, win as never, true);
    notifications[0]!.fire('click');
    expect(win.show).not.toHaveBeenCalled();
  });
});

describe('registerNotificationIPC', () => {
  beforeEach(() => {
    notifications.length = 0;
    vi.mocked(ipcMain.handle).mockClear();
    // Reset the rate limiter window for this renderer.
    notificationRateLimiter.dispose(1);
    registerNotificationIPC(() => null, true);
  });

  it('registers all five notification channels', () => {
    const channels = vi.mocked(ipcMain.handle).mock.calls.map((c) => c[0]);
    expect(channels).toEqual(
      expect.arrayContaining([
        IPC.notification.isSupported,
        IPC.notification.show,
        IPC.notification.requestComplete,
        IPC.notification.updateAvailable,
        IPC.notification.error,
      ])
    );
  });

  it('rate-limits notification:show after 10 calls in the window', async () => {
    const show = getRegisteredHandler(ipcMain, IPC.notification.show) as (
      e: unknown,
      p: unknown
    ) => Promise<unknown>;
    const opts = { title: 'T', body: 'B' };
    for (let i = 0; i < 10; i++) {
      await show(trustedEvent(1), opts);
    }
    await expect(show(trustedEvent(1), opts)).rejects.toThrow(/rate limit/i);
  });
});
