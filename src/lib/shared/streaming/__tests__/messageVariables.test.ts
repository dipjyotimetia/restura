import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolution = vi.hoisted(() => ({
  current: {
    values: {} as Record<string, string>,
    secretVariables: {} as Record<string, unknown>,
    secretNames: [] as string[],
  },
}));

vi.mock('@/lib/shared/activeRequestScopes', () => ({
  buildActiveRequestVariableResolution: () => resolution.current,
}));

import {
  formatUnresolvedWarning,
  getActiveStreamingVariableScope,
  resolveStreamingText,
  SECRET_MASK,
  type StreamingVariableScope,
} from '../messageVariables';

function scope(
  values: Record<string, string>,
  secret: string[] = [],
  handles: string[] = []
): StreamingVariableScope {
  return { values, secretNames: new Set(secret), handleNames: new Set(handles) };
}

describe('resolveStreamingText', () => {
  it('returns the text untouched when there are no tokens', () => {
    const out = resolveStreamingText('plain {not a var}', scope({ a: '1' }));
    expect(out).toEqual({
      wire: 'plain {not a var}',
      display: 'plain {not a var}',
      unresolved: [],
      usedSecret: false,
    });
  });

  it('resolves environment / collection values (whitespace tolerant)', () => {
    const out = resolveStreamingText(
      '{"id":"{{ userId }}","h":"{{host}}"}',
      scope({ userId: '42', host: 'x.io' })
    );
    expect(out.wire).toBe('{"id":"42","h":"x.io"}');
    expect(out.display).toBe(out.wire);
    expect(out.unresolved).toEqual([]);
  });

  it('keeps $-patterns in values literal', () => {
    const out = resolveStreamingText('{{v}}', scope({ v: '$&$1$$' }));
    expect(out.wire).toBe('$&$1$$');
  });

  it('masks secret values in the display copy only', () => {
    const out = resolveStreamingText(
      'auth {{token}} for {{user}}',
      scope({ token: 's3cr3t', user: 'bob' }, ['token'])
    );
    expect(out.wire).toBe('auth s3cr3t for bob');
    expect(out.display).toBe(`auth ${SECRET_MASK} for bob`);
    expect(out.display).not.toContain('s3cr3t');
    expect(out.usedSecret).toBe(true);
  });

  it('reports unknown and handle-only variables as unresolved, deduplicated', () => {
    const out = resolveStreamingText(
      '{{a}} {{missing}} {{missing}} {{vaultKey}}',
      scope({ a: '1' }, [], ['vaultKey'])
    );
    expect(out.wire).toBe('1 {{missing}} {{missing}} {{vaultKey}}');
    expect(out.unresolved).toEqual(['missing', 'vaultKey']);
  });

  it('resolves dynamic helpers once and mirrors the same value into the display', () => {
    const out = resolveStreamingText('{{$randomUUID}}', scope({}));
    expect(out.wire).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.display).toBe(out.wire);
    expect(out.unresolved).toEqual([]);
  });

  it('treats unknown dynamic helpers as unresolved', () => {
    const out = resolveStreamingText('{{$notAHelper}}', scope({}));
    expect(out.wire).toBe('{{$notAHelper}}');
    expect(out.unresolved).toEqual(['$notAHelper']);
  });

  it('does not re-expand tokens that appear inside a substituted value', () => {
    const out = resolveStreamingText('{{a}}', scope({ a: '{{b}}', b: 'nope' }));
    expect(out.wire).toBe('{{b}}');
  });
});

describe('resolveStreamingText json mode', () => {
  const s = () =>
    scope({ room: 'lobby","admin":true,"x":"y', n: '7', tok: 'a"b', path: 'c:\\d' }, ['tok']);

  it('JSON-escapes values substituted inside string literals', () => {
    const out = resolveStreamingText('{"room":"{{room}}","p":"{{path}}"}', s(), { json: true });
    expect(JSON.parse(out.wire)).toEqual({ room: 'lobby","admin":true,"x":"y', p: 'c:\\d' });
  });

  it('substitutes raw outside string literals (unquoted numbers / values)', () => {
    const out = resolveStreamingText('[{{n}}, "{{n}}"]', s(), { json: true });
    expect(JSON.parse(out.wire)).toEqual([7, '7']);
  });

  it('tracks escaped quotes when deciding whether a token is inside a string', () => {
    const out = resolveStreamingText('{"a":"x\\"{{n}}", "b":{{n}}}', s(), { json: true });
    expect(JSON.parse(out.wire)).toEqual({ a: 'x"7', b: 7 });
  });

  it('keeps secret values masked in the display copy and valid JSON on the wire', () => {
    const out = resolveStreamingText('{"t":"{{tok}}"}', s(), { json: true });
    expect(JSON.parse(out.wire)).toEqual({ t: 'a"b' });
    expect(JSON.parse(out.display)).toEqual({ t: SECRET_MASK });
  });

  it('escapes dynamic helper output inside strings too', () => {
    const out = resolveStreamingText('"{{$randomUUID}}"', s(), { json: true });
    expect(JSON.parse(out.wire)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('formatUnresolvedWarning', () => {
  it('lists names as tokens', () => {
    expect(formatUnresolvedWarning(['a', 'b'])).toBe(
      'Unresolved variables sent literally: {{a}}, {{b}}'
    );
  });
});

describe('getActiveStreamingVariableScope', () => {
  beforeEach(() => {
    resolution.current = {
      values: { host: 'h', token: 't' },
      secretVariables: { vault: { kind: 'handle', id: 'x' } },
      secretNames: ['token'],
    };
  });

  it('builds a scope from the shared active-request resolution', () => {
    const s = getActiveStreamingVariableScope();
    expect(s.values).toEqual({ host: 'h', token: 't' });
    expect([...s.secretNames]).toEqual(['token']);
    expect([...s.handleNames]).toEqual(['vault']);
  });

  it('tolerates a resolution without secretNames', () => {
    resolution.current = { values: {}, secretVariables: {} } as never;
    expect(getActiveStreamingVariableScope().secretNames.size).toBe(0);
  });
});
