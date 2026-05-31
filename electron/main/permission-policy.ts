/**
 * Deny-by-default renderer permission policy (Electron security checklist #5).
 *
 * Restura's renderer only needs **sanitized clipboard writes** — the "copy"
 * buttons throughout the UI use `navigator.clipboard.writeText`. It never uses
 * camera, microphone, geolocation, MIDI, pointer-lock, or the Notification web
 * API (native notifications are shown from the main process, not the renderer).
 *
 * Without a handler, permission decisions fall to Chromium's defaults. Installing
 * a deny-by-default policy means a rendered-response XSS or a malicious shared
 * collection can't silently obtain a device permission.
 */
import type { Session, WebContents } from 'electron';
import { createLogger } from '../../src/lib/shared/logger';

const log = createLogger('permissions');

/**
 * The only capabilities the renderer may use. `clipboard-sanitized-write` backs
 * the copy buttons; everything else is denied. Keep this set as small as the
 * renderer genuinely needs — add an entry only alongside the feature that uses it.
 */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write']);

/**
 * Install deny-by-default permission handlers on a session. Covers both the
 * async request path (`getUserMedia`, geolocation, notifications, MIDI, …) and
 * the synchronous check path (clipboard, …).
 */
export function applyPermissionPolicy(ses: Session): void {
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    const granted = ALLOWED_PERMISSIONS.has(permission);
    if (!granted) {
      log.warn('denied renderer permission request', { permission });
    }
    callback(granted);
  });

  ses.setPermissionCheckHandler((_webContents, permission) => ALLOWED_PERMISSIONS.has(permission));

  // WebUSB / Web Serial / WebHID go through a separate device-chooser path that
  // the permission handlers above don't cover. The renderer uses none of them —
  // deny every device grant and cancel the chooser if anything ever requests one.
  ses.setDevicePermissionHandler(() => false);
  ses.on('select-serial-port', (event, _portList, _webContents, callback) => {
    event.preventDefault();
    callback('');
  });
  ses.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  ses.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
}

/**
 * Web Bluetooth uses a per-`WebContents` chooser event rather than a `Session`
 * one, so it can't be denied in `applyPermissionPolicy`. Kept here so all
 * device-access denials live in one place; call once per web-contents.
 */
export function denyWebContentsDeviceAccess(contents: WebContents): void {
  contents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault();
    callback('');
  });
}
