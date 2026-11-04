// A compose service that runs with DEV_BYPASS_AUTH=true is an unauthenticated
// proxy (and, with ENVIRONMENT=development, one that may reach localhost). It
// must never be published on every interface, or anyone on the LAN gets an
// open SSRF proxy. Pin each such service's port bindings to loopback.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

interface ComposeService {
  ports?: Array<string | { host_ip?: string }>;
  environment?: Record<string, string> | string[];
}

const ROOT = process.cwd();
const composeFiles = readdirSync(ROOT).filter((f) => /^docker-compose.*\.ya?ml$/.test(f));

function envValue(env: ComposeService['environment'], key: string): string | undefined {
  if (!env) return undefined;
  if (Array.isArray(env)) {
    const entry = env.find((e) => e.startsWith(`${key}=`));
    return entry?.slice(key.length + 1);
  }
  const value = env[key];
  return value === undefined ? undefined : String(value);
}

const LOOPBACK = /^(127\.0\.0\.1|\[::1\]|localhost):/;

describe('docker compose: auth-bypass stacks bind to loopback only', () => {
  it('finds the compose files', () => {
    expect(composeFiles).toContain('docker-compose.local.yml');
  });

  for (const file of composeFiles) {
    const doc = load(readFileSync(resolve(ROOT, file), 'utf8')) as {
      services?: Record<string, ComposeService>;
    };
    for (const [name, svc] of Object.entries(doc.services ?? {})) {
      if (envValue(svc.environment, 'DEV_BYPASS_AUTH') !== 'true') continue;
      it(`${file} › ${name} publishes ports on loopback only`, () => {
        for (const port of svc.ports ?? []) {
          if (typeof port === 'string') expect(port).toMatch(LOOPBACK);
          else expect(port.host_ip).toMatch(/^(127\.0\.0\.1|::1)$/);
        }
      });
    }
  }
});
