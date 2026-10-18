/**
 * Guard for main-owned state stored directly in userData (ADR 0030).
 *
 * electron-store files (`*.json`: secret handles, stdio consent, vault, …)
 * and key blobs (dotfiles) live at the userData root. The renderer-facing fs
 * channels must never reach them. The check runs on a canonical form of the
 * path so filesystem aliases cannot slip past a plain string comparison:
 *
 *  - the nearest existing ancestor is resolved with `realpath.native`
 *    (symlinks, and Windows 8.3 short names such as `RESTUR~1`);
 *  - on Windows, trailing dots/spaces are stripped from every segment and an
 *    NTFS stream suffix (`name:stream`, `name::$DATA`) is removed, matching
 *    how Win32 maps those names to the same file;
 *  - on Windows and macOS (case-insensitive by default), case is folded.
 *
 * Residual: a case-sensitive APFS/NTFS volume is treated as case-insensitive,
 * which only ever refuses more, never less.
 */

import * as fs from 'node:fs';
import * as nodePath from 'node:path';

function pathModule(platform: NodeJS.Platform) {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

/** Strip Win32 trailing dots/spaces per segment and an NTFS stream suffix on the last one. */
function normaliseWin32Segments(p: string): string {
  const parsed = nodePath.win32.parse(p);
  const rest = p.slice(parsed.root.length);
  const segments = rest.split(/[\\/]+/).filter((s) => s !== '');
  const cleaned = segments.map((segment, i) => {
    let s = segment;
    if (i === segments.length - 1) {
      const colon = s.indexOf(':');
      if (colon !== -1) s = s.slice(0, colon);
    }
    return s.replace(/[. ]+$/, '');
  });
  return parsed.root + cleaned.join('\\');
}

/** realpath of the nearest existing ancestor, with the missing suffix re-appended. */
function realpathNearest(p: string, platform: NodeJS.Platform): string {
  const pm = pathModule(platform);
  const missing: string[] = [];
  let current = p;
  for (let i = 0; i < 4096; i++) {
    try {
      const real = fs.realpathSync.native(current);
      return missing.length > 0 ? pm.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = pm.dirname(current);
      if (parent === current) return p;
      missing.push(pm.basename(current));
      current = parent;
    }
  }
  return p;
}

export function canonicalPathForCompare(
  p: string,
  platform: NodeJS.Platform = process.platform
): string {
  const pm = pathModule(platform);
  let out = pm.resolve(p);
  if (platform === 'win32') out = normaliseWin32Segments(out);
  out = realpathNearest(out, platform);
  if (platform === 'win32') out = normaliseWin32Segments(out);
  if (platform === 'win32' || platform === 'darwin') out = out.toLowerCase();
  return out;
}

/** True when `filePath` names a store file or key blob directly in `userDataPath`. */
export function isMainOwnedUserDataFile(
  filePath: string,
  userDataPath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const pm = pathModule(platform);
  const target = canonicalPathForCompare(filePath, platform);
  const root = canonicalPathForCompare(userDataPath, platform);
  if (pm.dirname(target) !== root) return false;
  const base = pm.basename(target);
  return base.startsWith('.') || base.toLowerCase().endsWith('.json');
}
