// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { Session } from 'electron';
import { applyPermissionPolicy, ALLOWED_PERMISSIONS } from '../permission-policy';

type RequestHandler = (
  wc: unknown,
  permission: string,
  callback: (granted: boolean) => void
) => void;
type CheckHandler = (wc: unknown, permission: string) => boolean;

function makeFakeSession() {
  const captured: { request?: RequestHandler; check?: CheckHandler } = {};
  const ses = {
    setPermissionRequestHandler: (h: RequestHandler) => {
      captured.request = h;
    },
    setPermissionCheckHandler: (h: CheckHandler) => {
      captured.check = h;
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
});
