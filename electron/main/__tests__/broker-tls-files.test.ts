// @vitest-environment node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restura-tls-'));
vi.mock('../storage/file-operations', () => ({
  // Allowlist = the temp dir only; everything else is "outside allowed directories".
  isPathSafe: (p: string) => path.resolve(p).startsWith(root + path.sep),
}));

import { loadBrokerTlsFiles, readBrokerTlsFile } from '../security/broker-tls-files';

describe('broker TLS files are read in main (SEC-K3)', () => {
  const ca = path.join(root, 'ca.pem');
  beforeAll(() => {
    fs.writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n');
    fs.writeFileSync(path.join(root, 'empty.pem'), '');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads allowlisted paths and folds them into PEM fields', async () => {
    const tls = await loadBrokerTlsFiles({ caPath: ca, rejectUnauthorized: false });
    expect(tls).toEqual({
      ca: expect.stringContaining('BEGIN CERTIFICATE'),
      rejectUnauthorized: false,
    });
  });

  it('refuses paths outside the allowlist, missing, empty and directory paths', async () => {
    await expect(readBrokerTlsFile('/etc/passwd', 'CA')).rejects.toThrow(/outside the allowed/);
    await expect(readBrokerTlsFile(path.join(root, 'nope.pem'), 'CA')).rejects.toThrow(/not found/);
    await expect(readBrokerTlsFile(path.join(root, 'empty.pem'), 'CA')).rejects.toThrow(/empty/);
    await expect(readBrokerTlsFile(root + path.sep + '.', 'CA')).rejects.toThrow();
  });

  it('keeps inline PEM supplied by programmatic callers', async () => {
    expect(await loadBrokerTlsFiles({ ca: 'INLINE', caPath: ca })).toEqual({ ca: 'INLINE' });
  });
});
