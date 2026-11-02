import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createResilientStore, MAX_CORRUPT_BACKUPS } from '../resilient-store';

// Real electron-store 12 / conf 16 against a temp dir. electron-store's own
// `electron` import is not mockable from here, so an absolute `cwd` is passed.
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resilient-store-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const backups = (name: string) =>
  fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${name}.corrupt-`) && f.endsWith('.json'))
    .sort();

describe('createResilientStore', () => {
  it('opens a healthy encrypted store untouched and creates no backup', () => {
    const a = createResilientStore({ name: 's', cwd: dir, encryptionKey: KEY_A });
    a.set('k', 'v');
    const b = createResilientStore({ name: 's', cwd: dir, encryptionKey: KEY_A });
    expect(b.get('k')).toBe('v');
    expect(backups('s')).toHaveLength(0);
  });

  it('preserves the original bytes when the key no longer decrypts', () => {
    const a = createResilientStore({ name: 's', cwd: dir, encryptionKey: KEY_A });
    a.set('k', 'secret');
    const original = fs.readFileSync(path.join(dir, 's.json'));

    const b = createResilientStore({ name: 's', cwd: dir, encryptionKey: KEY_B });
    const files = backups('s');
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, files[0] as string)).equals(original)).toBe(true);
    // fresh store is usable
    expect(b.get('k')).toBeUndefined();
    b.set('n', 1);
    expect(b.get('n')).toBe(1);
  });

  it('backs up a syntax-corrupted (plaintext) file', () => {
    fs.writeFileSync(path.join(dir, 'p.json'), '{ not json');
    const s = createResilientStore({ name: 'p', cwd: dir });
    const files = backups('p');
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, files[0] as string), 'utf8')).toBe('{ not json');
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(dir, files[0] as string)).mode & 0o777).toBe(0o600);
    }
    s.set('x', 1);
    expect(s.get('x')).toBe(1);
  });

  it('keeps at most MAX_CORRUPT_BACKUPS backups, dropping the oldest', () => {
    const seen: string[] = [];
    for (let i = 0; i < MAX_CORRUPT_BACKUPS + 2; i++) {
      fs.writeFileSync(path.join(dir, 'c.json'), `{ bad ${i}`);
      createResilientStore({ name: 'c', cwd: dir });
      seen.push(`{ bad ${i}`);
    }
    const files = backups('c');
    expect(files).toHaveLength(MAX_CORRUPT_BACKUPS);
    const contents = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    expect(contents).toEqual(seen.slice(-MAX_CORRUPT_BACKUPS));
  });

  it('does not touch other stores backups', () => {
    fs.writeFileSync(path.join(dir, 'other.corrupt-2020-01-01T00-00-00-000Z.json'), 'x');
    fs.writeFileSync(path.join(dir, 'c.json'), '{ bad');
    createResilientStore({ name: 'c', cwd: dir });
    expect(backups('other')).toHaveLength(1);
  });
});
