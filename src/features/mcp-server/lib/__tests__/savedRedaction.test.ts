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
