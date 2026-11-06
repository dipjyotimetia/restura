import { describe, expect, it } from 'vitest';
import { applyPathVariables, pathVariableNames, syncPathVariableRows } from './path-variables';

const row = (key: string, value: string, enabled = true) => ({ key, value, enabled });
const plain = (r: { value: string }) => r.value;

describe('pathVariableNames', () => {
  it('lists whole `:name` path segments in order, once each', () => {
    expect(pathVariableNames('https://api.test/users/:id/posts/:postId/:id')).toEqual([
      'id',
      'postId',
    ]);
  });

  it('ignores host:port, userinfo, query and fragment colons', () => {
    expect(
      pathVariableNames('http://u:p@localhost:8080/a/:x?q=:notpath&b=1:2#:frag/:nope')
    ).toEqual(['x']);
  });

  it('reads the path of a scheme-less {{baseUrl}} URL', () => {
    expect(pathVariableNames('{{baseUrl}}/users/:id')).toEqual(['id']);
    expect(pathVariableNames('{{host}}:8080/users/:id')).toEqual(['id']);
  });

  it('needs a whole segment: a bare `:`, `a:b` and `:{{x}}` are not variables', () => {
    expect(pathVariableNames('https://h/:/a:b/x:/:{{x}}/:ok')).toEqual(['ok']);
  });
});

describe('applyPathVariables', () => {
  it('substitutes enabled rows in the path only', () => {
    expect(
      applyPathVariables(
        'http://localhost:8080/users/:id?filter=:id#:id',
        [row('id', '42'), row('localhost', 'x'), row('8080', 'y')],
        { resolve: plain }
      )
    ).toBe('http://localhost:8080/users/42?filter=:id#:id');
  });

  it('percent-encodes values as one path segment', () => {
    expect(
      applyPathVariables('https://h/files/:name', [row('name', 'a b/c?d#e%f')], {
        resolve: plain,
      })
    ).toBe('https://h/files/a%20b%2Fc%3Fd%23e%25f');
  });

  it('keeps existing %XX escapes and pchar sub-delims', () => {
    expect(
      applyPathVariables('https://h/:v', [row('v', "a%20b;c=d:e@f!$&'()*+,é")], {
        resolve: plain,
      })
    ).toBe("https://h/a%20b;c=d:e@f!$&'()*+,%C3%A9");
  });

  it('with encode off only escapes the delimiters that would change the structure', () => {
    expect(
      applyPathVariables('https://h/:v', [row('v', 'a b/c?d#e')], {
        resolve: plain,
        encode: false,
      })
    ).toBe('https://h/a b%2Fc%3Fd%23e');
  });

  it('resolves {{vars}} in values before encoding', () => {
    const vars: Record<string, string> = { userId: 'u 1' };
    expect(
      applyPathVariables('https://h/users/:id', [row('id', '{{userId}}')], {
        resolve: (r) => r.value.replace(/\{\{(\w+)\}\}/g, (_, n: string) => vars[n] ?? ''),
      })
    ).toBe('https://h/users/u%201');
  });

  it('leaves a disabled row, an empty value and an unknown name literal', () => {
    expect(
      applyPathVariables(
        'https://h/:off/:empty/:unknown/:on',
        [row('off', '1', false), row('empty', ''), row('on', 'yes')],
        { resolve: plain }
      )
    ).toBe('https://h/:off/:empty/:unknown/yes');
  });

  it('replaces every occurrence of a repeated name; the last enabled row wins', () => {
    expect(
      applyPathVariables('https://h/:a/x/:a', [row('a', '1'), row('a', '2')], { resolve: plain })
    ).toBe('https://h/2/x/2');
  });

  it('does not touch a [v6]:port authority', () => {
    expect(
      applyPathVariables('http://[::1]:3000/:id', [row('id', '7'), row('1', 'x')], {
        resolve: plain,
      })
    ).toBe('http://[::1]:3000/7');
  });

  it('keeps tokens the host materializes later verbatim', () => {
    expect(
      applyPathVariables('https://h/:k', [row('k', 'a {{token}} b')], {
        resolve: plain,
        keepToken: (name) => name === 'token',
      })
    ).toBe('https://h/a%20{{token}}%20b');
  });

  it('returns the URL unchanged when there are no rows', () => {
    expect(applyPathVariables('https://h/:id', [], { resolve: plain })).toBe('https://h/:id');
    expect(applyPathVariables('https://h/:id', undefined, { resolve: plain })).toBe(
      'https://h/:id'
    );
  });
});

describe('syncPathVariableRows', () => {
  let n = 0;
  const makeId = () => `id-${++n}`;

  it('adds new names, drops removed ones and keeps values for names that remain', () => {
    const current = [
      { id: 'a', key: 'id', value: '42', enabled: true, description: 'user id' },
      { id: 'b', key: 'gone', value: 'x', enabled: true },
    ];
    expect(syncPathVariableRows('https://h/users/:id/:postId', current, makeId)).toEqual([
      { id: 'a', key: 'id', value: '42', enabled: true, description: 'user id' },
      { id: 'id-1', key: 'postId', value: '', enabled: true },
    ]);
  });

  it('returns the same array when nothing changed (no store churn)', () => {
    const current = [{ id: 'a', key: 'id', value: '1', enabled: true }];
    expect(syncPathVariableRows('https://h/:id', current, makeId)).toBe(current);
    const empty: never[] = [];
    expect(syncPathVariableRows('https://h/x', empty, makeId)).toBe(empty);
  });
});
