import { promises as fsp } from 'node:fs';

import { isPathRealSafe, isPathSafe } from '../storage/file-operations';

// PEM bundles are small; anything bigger is not a certificate/key file.
const MAX_TLS_FILE_BYTES = 256 * 1024;

/**
 * Read a user-picked TLS file (CA bundle, client cert, private key) for a
 * broker connection in main, so the key material never transits the renderer
 * (SEC-K3). Paths go through the same allowlist / credential-directory denylist
 * as `fs:readFile`.
 */
export async function readBrokerTlsFile(filePath: string, label: string): Promise<string> {
  // Lexical allowlist first, then the symlink-resolved one: a link inside an
  // allowed folder must not reach a denylisted credential directory.
  const real = await fsp.realpath(filePath).catch(() => filePath);
  if (!isPathSafe(filePath) || !isPathSafe(real) || !(await isPathRealSafe(filePath))) {
    throw new Error(`TLS ${label} file is outside the allowed directories`);
  }
  let handle: Awaited<ReturnType<typeof fsp.open>>;
  try {
    handle = await fsp.open(filePath, 'r');
  } catch {
    throw new Error(`TLS ${label} file not found: ${filePath}`);
  }
  try {
    // fstat + bounded read on the same descriptor: no stat/read swap window.
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`TLS ${label} path is not a file: ${filePath}`);
    if (stats.size > MAX_TLS_FILE_BYTES) throw new Error(`TLS ${label} file is too large`);
    const buf = Buffer.alloc(MAX_TLS_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead > MAX_TLS_FILE_BYTES) throw new Error(`TLS ${label} file is too large`);
    const content = buf.subarray(0, bytesRead).toString('utf-8');
    if (!content.trim()) throw new Error(`TLS ${label} file is empty: ${filePath}`);
    return content;
  } finally {
    await handle.close();
  }
}

/**
 * Fold `{ caPath, certPath, keyPath }` into PEM contents. Inline PEM already
 * on the config wins (programmatic callers / tests).
 */
export async function loadBrokerTlsFiles<
  T extends {
    ca?: string;
    cert?: string;
    key?: string;
    caPath?: string;
    certPath?: string;
    keyPath?: string;
  },
>(tls: T): Promise<Omit<T, 'caPath' | 'certPath' | 'keyPath'>> {
  const { caPath, certPath, keyPath, ...rest } = tls;
  const [ca, cert, key] = await Promise.all([
    rest.ca === undefined && caPath ? readBrokerTlsFile(caPath, 'CA') : undefined,
    rest.cert === undefined && certPath ? readBrokerTlsFile(certPath, 'certificate') : undefined,
    rest.key === undefined && keyPath ? readBrokerTlsFile(keyPath, 'key') : undefined,
  ]);
  return {
    ...rest,
    ...(ca !== undefined ? { ca } : {}),
    ...(cert !== undefined ? { cert } : {}),
    ...(key !== undefined ? { key } : {}),
  };
}
