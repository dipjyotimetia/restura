import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// The Redpanda echo broker has several NON-OBVIOUS, load-bearing config settings
// that nothing else in CI exercises (the broker only runs under Docker). A silent
// regression here breaks the whole Kafka SASL/SSL surface. This test pins the
// invariants discovered while bringing the broker up — see
// echo-local/redpanda/bootstrap.yaml + redpanda.yaml.

const read = (rel: string): string => readFileSync(join(process.cwd(), 'echo-local', rel), 'utf8');

interface Listener {
  name: string;
  port: number;
  authentication_method?: string;
}

describe('echo-local Redpanda config invariants', () => {
  it('bootstrap.yaml enables SASL without ACL authorization, mechanism family SCRAM', () => {
    const boot = parse(read('redpanda/bootstrap.yaml')) as {
      enable_sasl: boolean;
      kafka_enable_authorization: boolean;
      sasl_mechanisms: string[];
    };
    expect(boot.enable_sasl).toBe(true);
    // MUST be explicit false — it defaults to enable_sasl, and ACLs-on would
    // deny the anonymous none-listeners + the in-cluster Schema Registry.
    expect(boot.kafka_enable_authorization).toBe(false);
    // Redpanda takes the family name "SCRAM" (advertises 256+512); the full
    // "SCRAM-SHA-256" string is rejected as an invalid mechanism.
    expect(boot.sasl_mechanisms).toContain('SCRAM');
    expect(boot.sasl_mechanisms).not.toContain('SCRAM-SHA-256');
  });

  it('redpanda.yaml exposes one listener per client security protocol with correct auth', () => {
    const node = parse(read('redpanda/redpanda.yaml')) as {
      redpanda: { kafka_api: Listener[]; kafka_api_tls: { name: string; enabled: boolean }[] };
      schema_registry: { schema_registry_api: { port: number }[] };
    };
    const byName = new Map(node.redpanda.kafka_api.map((l) => [l.name, l]));

    // none-auth listeners (anonymous): internal (SR/healthcheck) + plaintext + ssl.
    for (const n of ['internal', 'plaintext', 'ssl']) {
      expect(byName.get(n)?.authentication_method, n).toBe('none');
    }
    // SASL listeners.
    for (const n of ['sasl', 'sasl_ssl']) {
      expect(byName.get(n)?.authentication_method, n).toBe('sasl');
    }
    // TLS is enabled on exactly the ssl + sasl_ssl listeners.
    const tls = new Map(node.redpanda.kafka_api_tls.map((t) => [t.name, t.enabled]));
    expect(tls.get('ssl')).toBe(true);
    expect(tls.get('sasl_ssl')).toBe(true);
    // Schema Registry on 8081 (PORTS.schemaRegistry).
    expect(node.schema_registry.schema_registry_api.some((a) => a.port === 8081)).toBe(true);
  });

  it('docker-compose wires the cert/config/setup init services for Kafka', () => {
    const compose = parse(read('docker-compose.yml')) as {
      services: Record<string, { depends_on?: unknown }>;
    };
    for (const svc of ['kafka', 'kafka-certs', 'kafka-config', 'kafka-setup']) {
      expect(compose.services[svc], svc).toBeDefined();
    }
    // The SASL user is provisioned with SCRAM-SHA-256 (one cred per user).
    const setup = JSON.stringify(compose.services['kafka-setup']);
    expect(setup).toContain('SCRAM-SHA-256');
    expect(setup).toContain('restura');
  });
});
