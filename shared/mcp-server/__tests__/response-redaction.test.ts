import { describe, expect, it } from 'vitest';
import { REDACTED, redactBodyForAgent, redactHeadersForAgent } from '../redaction';

const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

describe('redactHeadersForAgent', () => {
  it('masks credential headers case-insensitively and keeps the rest', () => {
    expect(
      redactHeadersForAgent({
        'Set-Cookie': ['a=1', 'b=2'],
        Authorization: 'Bearer x',
        'content-type': 'application/json',
        'X-Api-Key': 'k',
        skipped: undefined,
      })
    ).toEqual({
      'Set-Cookie': REDACTED,
      Authorization: REDACTED,
      'content-type': 'application/json',
      'X-Api-Key': REDACTED,
    });
  });
});

describe('redactBodyForAgent', () => {
  it('masks token-like JSON fields at any depth, in any casing/separator', () => {
    const body = JSON.stringify({
      access_token: 'abc',
      data: { refreshToken: 'def', user: { name: 'Ada', 'client-secret': 's', csrfToken: 1 } },
      list: [{ password: 'p' }],
      tokenType: 'Bearer',
    });
    const out = redactBodyForAgent(body, { redact: true, maxChars: 10_000 });
    const parsed = JSON.parse(out.text);
    expect(parsed.access_token).toBe(REDACTED);
    expect(parsed.data.refreshToken).toBe(REDACTED);
    expect(parsed.data.user['client-secret']).toBe(REDACTED);
    expect(parsed.data.user.csrfToken).toBe(REDACTED);
    expect(parsed.data.user.name).toBe('Ada');
    expect(parsed.list[0].password).toBe(REDACTED);
    // A type label is not a credential.
    expect(parsed.tokenType).toBe('Bearer');
    expect(out.redactions).toBe(5);
  });

  it('masks JWTs inside plain text and JSON strings', () => {
    expect(redactBodyForAgent(`token is ${JWT}.`, { redact: true, maxChars: 1000 }).text).toBe(
      'token is (redacted-jwt).'
    );
    const json = redactBodyForAgent(JSON.stringify({ note: `x ${JWT}` }), {
      redact: true,
      maxChars: 1000,
    });
    expect(JSON.parse(json.text).note).toBe('x (redacted-jwt)');
  });

  it('leaves a clean JSON body byte-identical', () => {
    const body = '{"a":1,"b":[true]}';
    expect(redactBodyForAgent(body, { redact: true, maxChars: 1000 })).toEqual({
      text: body,
      originalLength: body.length,
      truncated: false,
      redactions: 0,
    });
  });

  it('does nothing but truncate when redaction is off', () => {
    const out = redactBodyForAgent(JSON.stringify({ password: 'p' }), {
      redact: false,
      maxChars: 5,
    });
    expect(out).toMatchObject({ text: '{"pas', truncated: true, redactions: 0 });
  });

  it('truncates after redaction and survives invalid JSON / undefined bodies', () => {
    expect(redactBodyForAgent('{not json', { redact: true, maxChars: 100 }).text).toBe('{not json');
    expect(redactBodyForAgent(undefined, { redact: true, maxChars: 100 })).toMatchObject({
      text: '',
      originalLength: 0,
    });
  });
});

describe('redactBodyForAgent — form-encoded pairs', () => {
  it('masks token-like keys in urlencoded bodies and keeps the rest', () => {
    const out = redactBodyForAgent('user=ada&password=hunter2&client_secret=s3&q=1', {
      redact: true,
      maxChars: 1000,
    });
    expect(out.text).toBe('user=ada&password=(redacted)&client_secret=(redacted)&q=1');
    expect(out.redactions).toBe(2);
  });

  it('decodes percent-encoded keys before matching', () => {
    expect(redactBodyForAgent('api%5Fkey=abc', { redact: true, maxChars: 100 }).text).toBe(
      'api%5Fkey=(redacted)'
    );
  });
});
