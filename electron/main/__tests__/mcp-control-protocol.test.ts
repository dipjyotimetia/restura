import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clientLabelFromHeaders,
  handshakePath,
  isAuthorized,
  isProcessAlive,
  mintToken,
  readHandshake,
  rejectControlRequest,
  writeHandshake,
} from '../handlers/mcp-control-protocol';

describe('rejectControlRequest', () => {
  it.each([
    ['127.0.0.1:4100'],
    ['localhost:4100'],
    ['LOCALHOST:4100'],
    ['[::1]:4100'],
    ['127.0.0.1'],
  ])('accepts an MCP client on loopback host %s', (host) => {
    expect(rejectControlRequest({ host })).toBeNull();
  });

  it.each([
    ['evil.example:4100'],
    ['127.0.0.1.nip.io:4100'],
    ['localhost.evil.example'],
    ['10.0.0.5:4100'],
  ])('refuses a non-loopback (DNS-rebound) host %s', (host) => {
    expect(rejectControlRequest({ host })).toBe('host');
  });

  it('refuses a missing Host header', () => {
    expect(rejectControlRequest({})).toBe('host');
  });

  it('refuses anything a browser sent, even from a loopback origin', () => {
    expect(rejectControlRequest({ host: '127.0.0.1:1', origin: 'http://127.0.0.1:1' })).toBe(
      'browser-origin'
    );
    expect(rejectControlRequest({ host: '127.0.0.1:1', origin: 'https://evil.example' })).toBe(
      'browser-origin'
    );
    expect(rejectControlRequest({ host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' })).toBe(
      'browser-origin'
    );
    expect(rejectControlRequest({ host: '127.0.0.1:1', 'sec-fetch-dest': 'empty' })).toBe(
      'browser-origin'
    );
  });

  it("accepts Node's built-in fetch, which sends Sec-Fetch-Mode but no Origin / Sec-Fetch-Site", () => {
    expect(
      rejectControlRequest({ host: '127.0.0.1:1', 'sec-fetch-mode': 'cors', 'user-agent': 'node' })
    ).toBeNull();
  });
});

describe('bearer auth', () => {
  it('requires the exact token', () => {
    const token = mintToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(isAuthorized({ authorization: `Bearer ${token}` }, token)).toBe(true);
    expect(isAuthorized({ authorization: `Bearer ${token}x` }, token)).toBe(false);
    expect(isAuthorized({ authorization: token }, token)).toBe(false);
    expect(isAuthorized({}, token)).toBe(false);
    // An unconfigured server refuses everything.
    expect(isAuthorized({ authorization: 'Bearer ' }, '')).toBe(false);
  });

  it('mints a fresh token each time', () => {
    expect(mintToken()).not.toBe(mintToken());
  });
});

describe('clientLabelFromHeaders', () => {
  it('prefers the shim header, falls back to User-Agent, strips control characters', () => {
    expect(
      clientLabelFromHeaders({
        'x-restura-mcp-client': 'claude-code/2.0 (stdio)',
        'user-agent': 'x',
      })
    ).toBe('claude-code/2.0 (stdio)');
    expect(clientLabelFromHeaders({ 'user-agent': 'codex\u0007\n/1' })).toBe('codex/1');
    expect(clientLabelFromHeaders({ 'user-agent': 'a'.repeat(500) })).toHaveLength(120);
    expect(clientLabelFromHeaders({})).toBeUndefined();
  });
});

describe('handshake file', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'restura-handshake-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sample = () => ({
    version: 1 as const,
    running: true,
    port: 4100,
    token: mintToken(),
    pid: process.pid,
    updatedAt: Date.now(),
  });

  it('round-trips and is owner-only (0600)', async () => {
    const data = sample();
    await writeHandshake(dir, data);
    expect(await readHandshake(dir)).toEqual(data);
    if (process.platform !== 'win32') {
      expect((await stat(handshakePath(dir))).mode & 0o777).toBe(0o600);
    }
  });

  it('tightens permissions on a pre-existing world-readable file', async () => {
    await writeFile(handshakePath(dir), '{}', { mode: 0o644 });
    await writeHandshake(dir, sample());
    if (process.platform !== 'win32') {
      expect((await stat(handshakePath(dir))).mode & 0o777).toBe(0o600);
    }
  });

  it('treats a missing, corrupt or invalid file as absent', async () => {
    expect(await readHandshake(dir)).toBeNull();
    await writeFile(handshakePath(dir), 'not json');
    expect(await readHandshake(dir)).toBeNull();
    await writeFile(handshakePath(dir), JSON.stringify({ ...sample(), token: 'short' }));
    expect(await readHandshake(dir)).toBeNull();
  });

  it('leaves no temp files behind', async () => {
    await writeHandshake(dir, sample());
    await writeHandshake(dir, sample());
    const raw = await readFile(handshakePath(dir), 'utf8');
    expect(JSON.parse(raw).version).toBe(1);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(dir)).toEqual(['mcp-control.json']);
  });
});

describe('isProcessAlive', () => {
  it('detects this process and rejects an impossible pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
  });

  it('treats a process owned by another user (EPERM) as not ours', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    try {
      expect(isProcessAlive(1)).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });
});
