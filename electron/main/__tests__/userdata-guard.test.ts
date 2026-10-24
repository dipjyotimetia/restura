// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalPathForCompare, isMainOwnedUserDataFile } from '../storage/userdata-guard';

describe('isMainOwnedUserDataFile (Windows name aliases)', () => {
  const root = 'C:\\Users\\me\\AppData\\Roaming\\Restura';
  const blocked = (p: string) => isMainOwnedUserDataFile(p, root, 'win32');

  it.each([
    'restura-secret-handles.json',
    'restura-secret-handles.json.',
    'restura-secret-handles.json. . ',
    'restura-secret-handles.json::$DATA',
    'restura-secret-handles.json:alt',
    'RESTURA-MCP-STDIO-CONSENT.JSON',
    '.mcp-stdio-consent-key',
    '.mcp-stdio-consent-key.',
  ])('blocks %s', (name) => expect(blocked(`${root}\\${name}`)).toBe(true));

  it('blocks via a case-variant or trailing-dot directory alias', () => {
    expect(blocked('c:\\users\\ME\\appdata\\roaming\\restura\\x.json')).toBe(true);
    expect(blocked('C:\\Users\\me\\AppData\\Roaming\\Restura.\\x.json')).toBe(true);
  });

  it('allows subdirectories and non-store files', () => {
    expect(blocked(`${root}\\collections\\x.json`)).toBe(false);
    expect(blocked(`${root}\\notes.txt`)).toBe(false);
  });
});

describe('isMainOwnedUserDataFile (POSIX, real filesystem)', () => {
  let base: string;
  let userData: string;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'userdata-guard-'));
    userData = path.join(base, 'Restura');
    mkdirSync(userData);
    writeFileSync(path.join(userData, 'restura-secret-handles.json'), '{}');
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('blocks store files reached through a symlinked directory', () => {
    const alias = path.join(base, 'alias');
    symlinkSync(userData, alias);
    expect(
      isMainOwnedUserDataFile(path.join(alias, 'restura-secret-handles.json'), userData, 'linux')
    ).toBe(true);
  });

  it('folds case on darwin', () => {
    const variant = path.join(base, 'RESTURA', 'Restura-Secret-Handles.JSON');
    expect(isMainOwnedUserDataFile(variant, userData, 'darwin')).toBe(true);
    expect(canonicalPathForCompare(variant, 'darwin')).toBe(
      canonicalPathForCompare(path.join(userData, 'restura-secret-handles.json'), 'darwin')
    );
  });

  it('keeps case on linux and allows subdirectories', () => {
    expect(isMainOwnedUserDataFile(path.join(userData, 'sub', 'x.json'), userData, 'linux')).toBe(
      false
    );
    expect(isMainOwnedUserDataFile(path.join(userData, 'x.txt'), userData, 'linux')).toBe(false);
  });
});
