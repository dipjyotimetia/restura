import { RequestPatchSchema } from '@shared/mcp-server/control-tools';
import { describe, expect, it } from 'vitest';
import type { HttpRequest } from '@/types';
import {
  containsPlaceholder,
  redactKeyValues,
  redactSavedText,
  redactSavedUrl,
  restoreRedactedPatch,
} from '../savedRedaction';

const SAVED: HttpRequest = {
  id: 'r',
  name: 'Login',
  type: 'http',
  method: 'POST',
  url: 'https://admin:pw@api.example.com/login',
  headers: [
    { id: 'h1', key: 'X-Api-Key', value: 'sk_live_123', enabled: true },
    { id: 'h2', key: 'Accept', value: 'application/json', enabled: true },
  ],
  params: [{ id: 'p1', key: 'api_key', value: 'qk_456', enabled: true }],
  body: {
    type: 'graphql',
    raw: JSON.stringify({ user: 'a', password: 'hunter2' }),
    graphqlVariables: JSON.stringify({ password: 'gql-pw' }),
  },
  auth: { type: 'none' },
};

const patch = (raw: unknown) => RequestPatchSchema.parse(raw);

describe('restoreRedactedPatch', () => {
  it('a get_request → update_request round trip keeps every real secret', () => {
    const headers = [...redactKeyValues(SAVED.headers), { key: 'X-Trace', value: '1' }];
    const out = restoreRedactedPatch(
      SAVED,
      patch({
        url: redactSavedUrl(SAVED.url),
        headers,
        params: redactKeyValues(SAVED.params),
        body: {
          type: 'graphql',
          content: redactSavedText(SAVED.body.raw!),
          graphqlVariables: redactSavedText(SAVED.body.graphqlVariables!),
        },
      })
    );
    if (!out.ok) throw new Error(out.error);
    // Sanity: the agent really did see masks.
    expect(JSON.stringify(headers)).toContain('(redacted)');
    expect(out.value.url).toBe(SAVED.url);
    expect(out.value.headers).toEqual([
      { key: 'X-Api-Key', value: 'sk_live_123', enabled: true },
      { key: 'Accept', value: 'application/json', enabled: true },
      { key: 'X-Trace', value: '1' },
    ]);
    expect(out.value.params?.[0]?.value).toBe('qk_456');
    expect(out.value.body?.content).toBe(SAVED.body.raw);
    expect(out.value.body?.graphqlVariables).toBe(SAVED.body.graphqlVariables);
  });

  it('refuses a placeholder that does not match the saved row (new key or edited mask)', () => {
    expect(
      restoreRedactedPatch(
        SAVED,
        patch({ headers: [{ key: 'Authorization', value: '(redacted)' }] })
      )
    ).toMatchObject({ ok: false, error: expect.stringMatching(/headers “Authorization”/) });
    expect(
      restoreRedactedPatch(
        SAVED,
        patch({ body: { type: 'json', content: '{"user":"b","password":"(redacted)"}' } })
      )
    ).toMatchObject({ ok: false, error: expect.stringMatching(/^body contains/) });
    expect(
      restoreRedactedPatch(SAVED, patch({ url: 'https://admin:%28secret%29@other.example' }))
    ).toMatchObject({ ok: false });
    expect(restoreRedactedPatch(SAVED, patch({ testScript: 'x = "(redacted)"' }))).toMatchObject({
      ok: false,
    });
  });

  it('leaves patches without placeholders untouched', () => {
    const p = patch({ url: 'https://new.example', headers: [{ key: 'A', value: 'b' }] });
    expect(restoreRedactedPatch(SAVED, p)).toEqual({ ok: true, value: p });
  });
});

describe('containsPlaceholder', () => {
  it.each([
    ['(redacted)', true],
    ['(redacted-jwt)', true],
    ['(secret)', true],
    ['%28secret%29', true],
    [{ a: ['x', { b: '(REDACTED)' }] }, true],
    ['{{token}}', false],
    ['redacted', false],
  ])('%j → %s', (value, expected) => {
    expect(containsPlaceholder(value)).toBe(expected);
  });
});

describe('restoreRedactedPatch — round 2 edge cases', () => {
  it('rows sharing a key each keep their own secret, in order', () => {
    const saved: HttpRequest = {
      ...SAVED,
      headers: [
        { id: 'a', key: 'Authorization', value: 'Bearer dev', enabled: false },
        { id: 'b', key: 'Authorization', value: 'Bearer prod', enabled: true },
      ],
    };
    const rows = redactKeyValues(saved.headers);
    expect(rows.map((r) => r.value)).toEqual(['(redacted)', '(redacted)']);
    const out = restoreRedactedPatch(
      saved,
      patch({ headers: [...rows, { key: 'A', value: '1' }] })
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.value.headers?.map((h) => h.value)).toEqual(['Bearer dev', 'Bearer prod', '1']);
  });

  it('a third masked row with only two saved ones is refused, not guessed', () => {
    const saved: HttpRequest = {
      ...SAVED,
      headers: [{ id: 'a', key: 'Authorization', value: 'Bearer dev', enabled: true }],
    };
    const row = redactKeyValues(saved.headers)[0]!;
    expect(restoreRedactedPatch(saved, patch({ headers: [row, row] })).ok).toBe(false);
  });

  it('an edited URL on the same host keeps the saved user:pass; another host gets none', () => {
    const sameHost = restoreRedactedPatch(
      SAVED,
      patch({ url: 'https://api.example.com/v2/login' })
    );
    expect(sameHost).toMatchObject({
      ok: true,
      value: { url: 'https://admin:pw@api.example.com/v2/login' },
    });
    const otherHost = restoreRedactedPatch(SAVED, patch({ url: 'https://evil.example/login' }));
    expect(otherHost).toMatchObject({ ok: true, value: { url: 'https://evil.example/login' } });
    // Templated hosts work too.
    const templated: HttpRequest = { ...SAVED, url: 'https://u:p@{{host}}/a' };
    expect(restoreRedactedPatch(templated, patch({ url: 'https://{{host}}/b' }))).toMatchObject({
      ok: true,
      value: { url: 'https://u:p@{{host}}/b' },
    });
  });

  it('a body longer than get_request shows cannot be edited from the truncated copy', () => {
    const big: HttpRequest = {
      ...SAVED,
      body: { type: 'json', raw: JSON.stringify({ items: 'x'.repeat(150_000) }) },
    };
    const shown = redactSavedText(big.body.raw!);
    expect(shown.length).toBe(100_000);
    // Copied back unchanged: keeps the full saved body.
    expect(
      restoreRedactedPatch(big, patch({ body: { type: 'json', content: shown } }))
    ).toMatchObject({ ok: true, value: { body: { content: big.body.raw } } });
    // Edited from the truncated copy: refused.
    expect(
      restoreRedactedPatch(big, patch({ body: { type: 'json', content: `${shown}"}` } }))
    ).toMatchObject({ ok: false, error: expect.stringMatching(/longer than get_request shows/) });
    // Replaced outright: also refused — the agent never saw what it replaces.
    expect(
      restoreRedactedPatch(big, patch({ body: { type: 'json', content: '{"new":true}' } }))
    ).toMatchObject({ ok: false, error: expect.stringMatching(/longer than get_request shows/) });
    // Left out: the saved body stays.
    expect(restoreRedactedPatch(big, patch({ name: 'renamed' })).ok).toBe(true);
  });

  it('an edit near the top of a truncated body is refused, whatever its length', () => {
    const big: HttpRequest = {
      ...SAVED,
      body: { type: 'json', raw: JSON.stringify({ a: 1, items: 'x'.repeat(150_000) }) },
    };
    const shown = redactSavedText(big.body.raw!);
    const edited = shown.replace('"a":1', '"a":2');
    expect(edited).not.toBe(shown);
    expect(edited.length).toBeLessThanOrEqual(100_000);
    expect(
      restoreRedactedPatch(big, patch({ body: { type: 'json', content: edited } }))
    ).toMatchObject({ ok: false, error: expect.stringMatching(/longer than get_request shows/) });
  });

  it('a minified body that only passes the cap once re-indented by redaction is still guarded', () => {
    // ~93k characters saved, but masking the password re-indents it past 100k.
    const rows = Array.from({ length: 3_500 }, (_, i) => ({ id: i, v: 'abcdefgh' }));
    const raw = JSON.stringify({ password: 'hunter2', rows });
    expect(raw.length).toBeLessThan(100_000);
    const big: HttpRequest = { ...SAVED, body: { type: 'json', raw } };
    const shown = redactSavedText(raw);
    expect(shown.length).toBe(100_000);
    // Unchanged copy keeps the real password.
    expect(
      restoreRedactedPatch(big, patch({ body: { type: 'json', content: shown } }))
    ).toMatchObject({ ok: true, value: { body: { content: raw } } });
    // Any change, including a "fixed up" valid JSON, is refused.
    expect(
      restoreRedactedPatch(big, patch({ body: { type: 'json', content: '{"rows":[]}' } }))
    ).toMatchObject({ ok: false });
  });
});
