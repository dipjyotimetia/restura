// @vitest-environment node

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tmpDir = path.join(os.tmpdir(), 'restura-install-id-test');
const idFile = path.join(tmpDir, 'telemetry-install-id.json');

vi.mock('electron', () => ({
  app: { getPath: () => tmpDir },
}));

import { deleteInstallId, getOrCreateInstallId } from '../lifecycle/telemetry-install-id';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('telemetry-install-id', () => {
  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  it('creates a random v4 UUID on first use and returns the same one afterwards', () => {
    const first = getOrCreateInstallId();
    expect(first).toMatch(UUID_V4);
    expect(getOrCreateInstallId()).toBe(first);
    expect(JSON.parse(readFileSync(idFile, 'utf8'))).toEqual({ id: first });
  });

  it('does not reuse an id across installs', () => {
    const first = getOrCreateInstallId();
    rmSync(idFile);
    expect(getOrCreateInstallId()).not.toBe(first);
  });

  it('writes the file readable only by the owner', () => {
    getOrCreateInstallId();
    if (process.platform !== 'win32') {
      expect(statSync(idFile).mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    ['corrupt JSON', 'not json'],
    ['a non-UUID value', JSON.stringify({ id: 'alice@example.com' })],
    ['a missing id', JSON.stringify({})],
  ])('replaces %s rather than sending it', (_label, contents) => {
    writeFileSync(idFile, contents, 'utf8');
    const id = getOrCreateInstallId();
    expect(id).toMatch(UUID_V4);
    expect(JSON.parse(readFileSync(idFile, 'utf8'))).toEqual({ id });
  });

  // A fresh id per launch would count one install as many users, so an id that
  // can't be persisted must not be sent at all.
  it('returns undefined when the id cannot be persisted', () => {
    rmSync(tmpDir, { recursive: true, force: true });
    expect(getOrCreateInstallId()).toBeUndefined();
  });

  it('deleteInstallId removes the id and tolerates a missing file', () => {
    getOrCreateInstallId();
    deleteInstallId();
    expect(existsSync(idFile)).toBe(false);
    expect(() => deleteInstallId()).not.toThrow();
  });
});
