import { execSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface SelfSignedCert {
  key: Buffer;
  cert: Buffer;
}

/**
 * Generates (or reuses) a self-signed cert for 127.0.0.1 / localhost so the
 * mock HTTPS server has something to present. Cached under the OS temp dir
 * across test runs so we don't shell out every time.
 *
 * Uses openssl, which is preinstalled on macOS and most Linux CI images.
 * If openssl is unavailable we throw with a clear message.
 */
export function getSelfSignedCert(): SelfSignedCert {
  const dir = join(tmpdir(), 'restura-e2e-tls');
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');

  if (!existsSync(keyPath) || !existsSync(certPath)) {
    try {
      execSync(
        `openssl req -x509 -nodes -days 365 -newkey rsa:2048 ` +
          `-keyout "${keyPath}" -out "${certPath}" ` +
          `-subj "/CN=localhost" ` +
          `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`,
        { stdio: 'pipe' }
      );
    } catch (err) {
      throw new Error(
        `Failed to generate self-signed cert via openssl: ${(err as Error).message}. ` +
          `Install openssl or pre-generate ${keyPath} / ${certPath}.`
      );
    }
  }

  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  };
}
