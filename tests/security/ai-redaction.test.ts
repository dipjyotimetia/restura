// tests/security/ai-redaction.test.ts
import { describe, it, expect } from 'vitest';
import { redactBody, redactHeaders, detectUnredactedSecrets } from '@shared/protocol/ai/redaction';

const JWT_BODY = (s: string) => `{"token":"${s}"}`;

function randomJwt(): string {
  const part = (n: number) =>
    Array.from({ length: n }, () =>
      ('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'[
        Math.floor(Math.random() * 64)
      ] ?? 'A'),
    ).join('');
  return `eyJ${part(20)}.${part(60)}.${part(30)}`;
}

describe('redaction property tests', () => {
  it('100 random JWTs are all stripped', () => {
    for (let i = 0; i < 100; i++) {
      const jwt = randomJwt();
      const out = redactBody(JWT_BODY(jwt), 'default');
      expect(out).not.toContain(jwt);
    }
  });

  it('100 random Bearer tokens (sk-… style) are all stripped', () => {
    for (let i = 0; i < 100; i++) {
      const tok = `sk-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
      const line = `Authorization: Bearer ${tok}`;
      const out = redactBody(line, 'default');
      expect(out).not.toContain(tok);
    }
  });

  it('case variants of Authorization header are caught', () => {
    for (const name of ['authorization', 'Authorization', 'AUTHORIZATION', 'AuThOrIzAtIoN']) {
      const out = redactHeaders({ [name]: 'Bearer secret' }, 'default');
      expect(out[name]).toBe('[REDACTED]');
    }
  });

  it('detectUnredactedSecrets catches anything redactBody would have removed', () => {
    for (let i = 0; i < 50; i++) {
      const jwt = randomJwt();
      expect(detectUnredactedSecrets(JWT_BODY(jwt))).toBe(true);
    }
  });

  it('redactBody output never trips detectUnredactedSecrets', () => {
    for (let i = 0; i < 50; i++) {
      const jwt = randomJwt();
      const redacted = redactBody(JWT_BODY(jwt), 'default');
      expect(detectUnredactedSecrets(redacted)).toBe(false);
    }
  });
});

describe('prefix-recognizable provider/cloud tokens (no key name, no Bearer)', () => {
  // Synthetic, non-real tokens built from a prefix + filler at runtime. Assembling
  // them by concatenation means no contiguous secret-shaped literal exists in the
  // source, which avoids secret-scanning false positives (these are fixtures, not
  // real credentials) while the runtime values still match the redaction patterns.
  const FILL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const SECRETS = [
    'sk-' + FILL.slice(0, 32), // OpenAI
    'sk-ant-api03-' + FILL.slice(0, 30), // Anthropic
    'sk-or-v1-' + FILL.slice(0, 30), // OpenRouter
    'AKIA' + FILL.slice(0, 16), // AWS access key id
    'ghp_' + FILL.slice(0, 36), // GitHub PAT
    'github_pat_' + FILL.slice(0, 30), // GitHub fine-grained
    'xoxb-' + FILL.slice(0, 20), // Slack
    'AIza' + FILL.slice(0, 35), // Google API key
  ];

  it('strips each bare token from a body that uses an unrecognized key name', () => {
    for (const secret of SECRETS) {
      // Key is "value" — NOT api_key/secret/password/token, so only the
      // prefix-based patterns can catch it.
      const out = redactBody(`{"value":"${secret}"}`, 'default');
      expect(out, `leaked: ${secret}`).not.toContain(secret);
    }
  });

  it('detectUnredactedSecrets flags each bare token', () => {
    for (const secret of SECRETS) {
      expect(detectUnredactedSecrets(`{"value":"${secret}"}`), `missed: ${secret}`).toBe(true);
    }
  });

  it('redacts non-x- credential headers (api-key, private-token) but keeps www-authenticate', () => {
    const out = redactHeaders(
      {
        'api-key': 'secret-azure-key-value',
        'Private-Token': 'glpat-xxxxxxxxxxxx',
        'WWW-Authenticate': 'Bearer realm="api"',
      },
      'default',
    );
    expect(out['api-key']).toBe('[REDACTED]');
    expect(out['Private-Token']).toBe('[REDACTED]');
    // Challenge header is diagnostic, not a credential — must survive.
    expect(out['WWW-Authenticate']).toBe('Bearer realm="api"');
  });
});
