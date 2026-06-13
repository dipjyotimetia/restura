// Local certificate authority for the echo stack. Generates a CA, a CA-signed
// server leaf (SAN localhost/127.0.0.1 + optional custom domain), and a client
// leaf for mutual TLS — plus a PKCS#12 bundle so the desktop client's `pfx`
// path can be exercised too.
//
// Why a CA we import rather than mkcert/Caddy (which mutate the OS trust store):
// importing THIS CA into Restura's custom-CA setting and attaching the client
// leaf is exactly how you exercise the desktop-only `customCa` and `clientCert`
// features. Nothing here touches the system keychain.
//
// openssl-based, mirroring e2e/mocks/cert.ts (openssl ships on macOS and most
// Linux/CI images). Idempotent: existing material is reused unless `force`.

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface EchoCerts {
  dir: string;
  /** PEM of the CA cert — import this into Restura's custom-CA setting. */
  caPem: Buffer;
  caCertPath: string;
  /** CA-signed server leaf (used by the HTTPS / mTLS / MQTTS listeners). */
  serverKey: Buffer;
  serverCert: Buffer;
  serverKeyPath: string;
  serverCertPath: string;
  /** Client leaf for mutual TLS — attach in Restura's client-cert setting. */
  clientKey: Buffer;
  clientCert: Buffer;
  clientKeyPath: string;
  clientCertPath: string;
  /** PKCS#12 bundle of the client leaf (format `pfx`), passphrase below. */
  clientPfxPath: string;
  clientPfxPassphrase: string;
}

const PFX_PASSPHRASE = 'restura';

function openssl(args: string[]): void {
  try {
    execFileSync('openssl', args, { stdio: 'pipe' });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
    throw new Error(
      `openssl ${args[0]} failed: ${(err as Error).message}\n${stderr}\n` +
        `Install openssl, or pre-generate the certs under the certs/ directory.`
    );
  }
}

/**
 * Generate (or reuse) the CA + server + client material under `dir`.
 * Pass `force: true` to regenerate (used by the `certs` subcommand and whenever
 * a custom `--domain` is requested so the SAN is rebuilt).
 */
export function ensureCerts(opts: {
  dir: string;
  domain?: string | undefined;
  force?: boolean;
}): EchoCerts {
  const { dir, domain, force } = opts;
  mkdirSync(dir, { recursive: true });

  const caKeyPath = join(dir, 'ca.key');
  const caCertPath = join(dir, 'ca.crt');
  const serverKeyPath = join(dir, 'server.key');
  const serverCertPath = join(dir, 'server.crt');
  const clientKeyPath = join(dir, 'client.key');
  const clientCertPath = join(dir, 'client.crt');
  const clientPfxPath = join(dir, 'client.p12');
  const domainMarker = join(dir, '.domain');

  const desiredDomain = domain ?? '';
  const currentDomain = existsSync(domainMarker) ? readFileSync(domainMarker, 'utf8').trim() : '';
  const stale = currentDomain !== desiredDomain;

  const allPresent = [
    caCertPath,
    serverKeyPath,
    serverCertPath,
    clientKeyPath,
    clientCertPath,
    clientPfxPath,
  ].every(existsSync);

  if (force || stale || !allPresent) {
    for (const f of [
      caKeyPath,
      caCertPath,
      serverKeyPath,
      serverCertPath,
      clientKeyPath,
      clientCertPath,
      clientPfxPath,
    ]) {
      rmSync(f, { force: true });
    }
    generate({
      dir,
      domain: desiredDomain,
      caKeyPath,
      caCertPath,
      serverKeyPath,
      serverCertPath,
      clientKeyPath,
      clientCertPath,
      clientPfxPath,
    });
    writeFileSync(domainMarker, desiredDomain);
  }

  return {
    dir,
    caPem: readFileSync(caCertPath),
    caCertPath,
    serverKey: readFileSync(serverKeyPath),
    serverCert: readFileSync(serverCertPath),
    serverKeyPath,
    serverCertPath,
    clientKey: readFileSync(clientKeyPath),
    clientCert: readFileSync(clientCertPath),
    clientKeyPath,
    clientCertPath,
    clientPfxPath,
    clientPfxPassphrase: PFX_PASSPHRASE,
  };
}

function generate(p: {
  dir: string;
  domain: string;
  caKeyPath: string;
  caCertPath: string;
  serverKeyPath: string;
  serverCertPath: string;
  clientKeyPath: string;
  clientCertPath: string;
  clientPfxPath: string;
}): void {
  const serverCsr = join(p.dir, 'server.csr');
  const clientCsr = join(p.dir, 'client.csr');
  const serverExt = join(p.dir, 'server.ext');
  const clientExt = join(p.dir, 'client.ext');
  const serial = join(p.dir, 'ca.srl');

  const sanEntries = ['DNS:localhost', 'IP:127.0.0.1'];
  if (p.domain) sanEntries.push(`DNS:${p.domain}`);
  writeFileSync(
    serverExt,
    `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${sanEntries.join(',')}\n`
  );
  writeFileSync(
    clientExt,
    `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=clientAuth\nsubjectAltName=DNS:restura-client\n`
  );

  // 1. CA (self-signed root)
  openssl([
    'req',
    '-x509',
    '-nodes',
    '-newkey',
    'rsa:2048',
    '-keyout',
    p.caKeyPath,
    '-out',
    p.caCertPath,
    '-days',
    '825',
    '-subj',
    '/CN=Restura Local Echo CA/O=Restura',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);

  // 2. Server leaf
  openssl([
    'req',
    '-nodes',
    '-newkey',
    'rsa:2048',
    '-keyout',
    p.serverKeyPath,
    '-out',
    serverCsr,
    '-subj',
    '/CN=localhost/O=Restura',
  ]);
  openssl([
    'x509',
    '-req',
    '-in',
    serverCsr,
    '-CA',
    p.caCertPath,
    '-CAkey',
    p.caKeyPath,
    '-CAcreateserial',
    '-out',
    p.serverCertPath,
    '-days',
    '825',
    '-extfile',
    serverExt,
  ]);

  // 3. Client leaf (mTLS)
  openssl([
    'req',
    '-nodes',
    '-newkey',
    'rsa:2048',
    '-keyout',
    p.clientKeyPath,
    '-out',
    clientCsr,
    '-subj',
    '/CN=restura-client/O=Restura',
  ]);
  openssl([
    'x509',
    '-req',
    '-in',
    clientCsr,
    '-CA',
    p.caCertPath,
    '-CAkey',
    p.caKeyPath,
    '-CAcreateserial',
    '-out',
    p.clientCertPath,
    '-days',
    '825',
    '-extfile',
    clientExt,
  ]);

  // 4. PKCS#12 bundle of the client leaf (exercises the desktop `pfx` path).
  // -legacy keeps the bundle readable by older PKCS#12 loaders.
  openssl([
    'pkcs12',
    '-export',
    '-legacy',
    '-inkey',
    p.clientKeyPath,
    '-in',
    p.clientCertPath,
    '-certfile',
    p.caCertPath,
    '-out',
    p.clientPfxPath,
    '-passout',
    `pass:${PFX_PASSPHRASE}`,
  ]);

  for (const f of [serverCsr, clientCsr, serverExt, clientExt, serial]) {
    rmSync(f, { force: true });
  }
}
