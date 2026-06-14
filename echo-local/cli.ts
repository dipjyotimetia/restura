// CLI for the local echo stack. Run via `npm run echo:local` (esbuild-bundled
// to dist/echo-local/cli.mjs, then node). npm runs scripts with cwd = repo root,
// which is where cert/manifest/collection output lands and where the gRPC dev
// server script is resolved from.
//
//   npm run echo:local                      boot everything, stay up
//   npm run echo:local -- --only http,grpc  subset
//   npm run echo:local -- --no-tls          skip https/mtls (mqtt keeps tcp)
//   npm run echo:local -- --domain echo.local
//   npm run echo:local:certs                regenerate CA + leaf certs, exit
//   npm run echo:local:collection           write the importable collection, exit
//   npm run echo:local -- manifest          write+print the manifest, exit

import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { ensureCerts, type EchoCerts } from './certs';
import { launch } from './launcher';
import { buildManifest, writeManifest, printManifest } from './manifest';
import { writeCollection } from './collection';
import { IN_PROCESS_SERVICES, PORTS, DEFAULT_HOST, type ServiceId } from './ports';

interface Args {
  command: 'up' | 'certs' | 'collection' | 'manifest';
  only?: Set<ServiceId>;
  tls: boolean;
  domain?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: 'up', tls: true };
  // Accepts both `--flag value` and `--flag=value`. Returns the value and
  // advances the index when the space form consumes the next token.
  const valueOf = (token: string, name: string, i: number): { value: string; next: number } => {
    if (token.startsWith(`${name}=`)) return { value: token.slice(name.length + 1), next: i };
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} requires a value`);
    return { value: v, next: i + 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === 'up' || token === 'certs' || token === 'collection' || token === 'manifest') {
      args.command = token;
    } else if (token === '--no-tls') {
      args.tls = false;
    } else if (token === '--only' || token.startsWith('--only=')) {
      const { value, next } = valueOf(token, '--only', i);
      args.only = parseOnly(value);
      i = next;
    } else if (token === '--domain' || token.startsWith('--domain=')) {
      const { value, next } = valueOf(token, '--domain', i);
      args.domain = value;
      i = next;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function parseOnly(value: string): Set<ServiceId> {
  const ids = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = new Set<string>(IN_PROCESS_SERVICES);
  const bad = ids.filter((id) => !valid.has(id));
  if (bad.length > 0) {
    throw new Error(
      `Unknown service(s): ${bad.join(', ')}. Valid: ${IN_PROCESS_SERVICES.join(', ')}`
    );
  }
  return new Set(ids as ServiceId[]);
}

const OUT_DIR = resolve(process.cwd(), 'echo-local');
const CERTS_DIR = resolve(OUT_DIR, 'certs');

function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    sock.setTimeout(800);
    const done = (up: boolean): void => {
      sock.destroy();
      resolve(up);
    };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** Best-effort: warn (don't fail) when the Docker brokers (Kafka, MQTT) aren't up. */
async function checkDockerBrokers(host: string): Promise<void> {
  const [kafka, mqtt] = await Promise.all([
    portOpen(host, PORTS.kafka),
    portOpen(host, PORTS.mqtt),
  ]);
  const down: string[] = [];
  if (!kafka) down.push('Kafka');
  if (!mqtt) down.push('MQTT');
  if (down.length > 0) {
    console.log(
      `  ⚠ ${down.join(' + ')} not reachable. Start the Docker brokers:\n` +
        '      docker compose -f echo-local/docker-compose.yml up -d\n'
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const host = args.domain || DEFAULT_HOST;

  if (args.command === 'collection') {
    const path = writeCollection(OUT_DIR, host);
    console.log(`Wrote ${path}`);
    return;
  }

  let certs: EchoCerts | undefined;
  if (args.tls) {
    certs = ensureCerts({ dir: CERTS_DIR, domain: args.domain, force: args.command === 'certs' });
  }

  if (args.command === 'certs') {
    console.log(`CA + leaf certs ready under ${CERTS_DIR}`);
    return;
  }

  if (args.command === 'manifest') {
    const manifest = buildManifest({ host, certs });
    const path = writeManifest(manifest, OUT_DIR);
    printManifest(manifest);
    console.log(`Wrote ${path}`);
    return;
  }

  // command === 'up'
  const { started, shutdown } = await launch({ only: args.only, tls: args.tls, certs });
  const manifest = buildManifest({ host, certs });
  writeManifest(manifest, OUT_DIR);
  const collectionPath = writeCollection(OUT_DIR, host);
  printManifest(manifest);
  console.log(`  Running: ${started.join(', ')}`);
  console.log(`  Importable collection: ${collectionPath}`);
  await checkDockerBrokers(host);
  console.log('  Ctrl+C to stop.\n');

  let closing = false;
  const stop = (): void => {
    if (closing) return;
    closing = true;
    console.log('\nShutting down…');
    void shutdown().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err: unknown) => {
  console.error(`echo-local: ${(err as Error).message}`);
  process.exit(1);
});
