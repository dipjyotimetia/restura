import { describe, it, expect } from 'vitest';
import { envHostHint, describeEnv } from '../envHint';
import type { Environment, KeyValue } from '@/types';

let seq = 0;
function kv(key: string, value: string, enabled = true): KeyValue {
  return { id: `kv-${seq++}`, key, value, enabled };
}
function env(variables: KeyValue[], name = 'Env'): Environment {
  return { id: 'env-1', name, variables };
}

describe('envHostHint', () => {
  it('returns null for a null/undefined env', () => {
    expect(envHostHint(null)).toBeNull();
    expect(envHostHint(undefined)).toBeNull();
  });

  it('extracts the host from a full URL value', () => {
    expect(envHostHint(env([kv('host', 'https://api.example.com/v1')]))).toBe('api.example.com');
  });

  it('keeps the port as part of the host', () => {
    expect(envHostHint(env([kv('baseUrl', 'http://localhost:8080/api')]))).toBe('localhost:8080');
  });

  it('recognises host-like keys case-insensitively and normalises dashes to underscores', () => {
    expect(envHostHint(env([kv('Base-Url', 'https://svc.internal')]))).toBe('svc.internal');
    expect(envHostHint(env([kv('API_HOST', 'https://h.example.org')]))).toBe('h.example.org');
  });

  it('falls back to stripping protocol/trailing slash when the value is not a parseable URL', () => {
    // Template strings like {{api}}.example.com fail `new URL`, so the catch path runs.
    expect(envHostHint(env([kv('host', '{{api}}.example.com')]))).toBe('{{api}}.example.com');
    expect(envHostHint(env([kv('host', 'http://plain-host/')]))).toBe('plain-host');
  });

  it('ignores disabled host variables', () => {
    expect(envHostHint(env([kv('host', 'https://api.example.com', false)]))).toBeNull();
  });

  it('ignores host variables with an empty value', () => {
    expect(envHostHint(env([kv('host', '')]))).toBeNull();
  });

  it('returns null when no host-like variable is present', () => {
    expect(envHostHint(env([kv('token', 'abc')]))).toBeNull();
  });

  it('uses the first matching enabled host variable', () => {
    const e = env([
      kv('token', 'x'),
      kv('url', 'https://first.example'),
      kv('host', 'https://second.example'),
    ]);
    expect(envHostHint(e)).toBe('first.example');
  });
});

describe('describeEnv', () => {
  it('prefers the host hint when one exists', () => {
    expect(describeEnv(env([kv('host', 'https://api.example.com')]))).toBe('api.example.com');
  });

  it('falls back to a pluralised variable count when no host is present', () => {
    expect(describeEnv(env([]))).toBe('0 variables');
    expect(describeEnv(env([kv('token', 'a')]))).toBe('1 variable');
    expect(describeEnv(env([kv('token', 'a'), kv('secret', 'b')]))).toBe('2 variables');
  });

  it('counts disabled variables in the fallback total', () => {
    // The fallback counts env.variables.length, not just enabled ones.
    expect(describeEnv(env([kv('token', 'a', false), kv('secret', 'b', false)]))).toBe(
      '2 variables'
    );
  });
});
