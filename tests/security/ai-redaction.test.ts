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
