// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { Session, WebContents } from 'electron';
import {
  applyPermissionPolicy,
  denyWebContentsDeviceAccess,
  ALLOWED_PERMISSIONS,
} from '../permission-policy';

type RequestHandler = (
  wc: unknown,
  permission: string,
  callback: (granted: boolean) => void
) => void;
type CheckHandler = (wc: unknown, permission: string) => boolean;
type DeviceHandler = (details: unknown) => boolean;

function makeFakeSession() {
  const captured: {
    request?: RequestHandler;
    check?: CheckHandler;
    device?: DeviceHandler;
    on: Record<string, (...args: unknown[]) => void>;
  } = { on: {} };
  const ses = {
    setPermissionRequestHandler: (h: RequestHandler) => {
      captured.request = h;
    },
    setPermissionCheckHandler: (h: CheckHandler) => {
      captured.check = h;
    },
    setDevicePermissionHandler: (h: DeviceHandler) => {
      captured.device = h;
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      captured.on[event] = handler;
    },
  } as unknown as Session;
  return { ses, captured };
}

describe('permission-policy', () => {
  it('allows only clipboard-sanitized-write', () => {
    expect([...ALLOWED_PERMISSIONS]).toEqual(['clipboard-sanitized-write']);
  });

  it('request handler grants the allowed permission and denies the rest', () => {
    const { ses, captured } = makeFakeSession();
    applyPermissionPolicy(ses);

    const grant = (permission: string): boolean => {
      const cb = vi.fn();
      captured.request!(null, permission, cb);
      expect(cb).toHaveBeenCalledTimes(1);
      return cb.mock.calls[0]![0] as boolean;
    };

    expect(grant('clipboard-sanitized-write')).toBe(true);
    for (const p of [
      'media',
      'geolocation',
      'notifications',
      'midi',
      'midiSysex',
      'openExternal',
    ]) {
      expect(grant(p)).toBe(false);
    }
  });

  it('check handler mirrors the allow-list (deny-by-default)', () => {
    const { ses, captured } = makeFakeSession();
    applyPermissionPolicy(ses);

    expect(captured.check!(null, 'clipboard-sanitized-write')).toBe(true);
    expect(captured.check!(null, 'clipboard-read')).toBe(false);
    expect(captured.check!(null, 'media')).toBe(false);
    expect(captured.check!(null, 'geolocation')).toBe(false);
  });

  it('denies all device permissions and cancels device choosers', () => {
    const { ses, captured } = makeFakeSession();
    applyPermissionPolicy(ses);

    expect(captured.device!({ deviceType: 'usb' })).toBe(false);
    expect(captured.device!({ deviceType: 'serial' })).toBe(false);
    expect(captured.device!({ deviceType: 'hid' })).toBe(false);

    // serial passes (event, portList, webContents, callback); hid/usb pass (event, details, callback)
    const serialCb = vi.fn();
    const serialPrevent = vi.fn();
    captured.on['select-serial-port']!({ preventDefault: serialPrevent }, [], undefined, serialCb);
    expect(serialPrevent).toHaveBeenCalled();
    expect(serialCb).toHaveBeenCalledWith('');

    for (const event of ['select-hid-device', 'select-usb-device']) {
      const preventDefault = vi.fn();
      const callback = vi.fn();
      captured.on[event]!({ preventDefault }, {}, callback);
      expect(preventDefault).toHaveBeenCalled();
      expect(callback).toHaveBeenCalled();
    }
  });

  it('denies the Web Bluetooth chooser per web-contents', () => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const contents = {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handler;
      },
    } as unknown as WebContents;

    denyWebContentsDeviceAccess(contents);

    const preventDefault = vi.fn();
    const callback = vi.fn();
    handlers['select-bluetooth-device']!({ preventDefault }, [], callback);
    expect(preventDefault).toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith('');
  });
});
