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
import type { Session } from 'electron';
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
}
