import { describe, expect, it } from 'vitest';
import type { KeyValue } from '@/types';
import { pathVariablesPatch } from '../pathVariableRows';
import { applyUrlInput } from '../urlQuery';

let n = 0;
const makeId = () => `new-${++n}`;

describe('pathVariablesPatch (URL edit → rows)', () => {
  it('adds a row for a new :name, keeps values for names that remain, drops removed ones', () => {
    const current: KeyValue[] = [
      { id: 'a', key: 'id', value: '42', enabled: true, description: 'user' },
      { id: 'b', key: 'old', value: 'x', enabled: true },
    ];
    const { url } = applyUrlInput('https://h/users/:id/posts/:postId?x=1', [], makeId);
    expect(pathVariablesPatch(url, current, makeId)).toEqual({
      pathVariables: [
        { id: 'a', key: 'id', value: '42', enabled: true, description: 'user' },
        { id: expect.any(String), key: 'postId', value: '', enabled: true },
      ],
    });
  });

  it('writes nothing when the names did not change, or a request never had any', () => {
    const current: KeyValue[] = [{ id: 'a', key: 'id', value: '1', enabled: true }];
    expect(pathVariablesPatch('https://h/u/:id/more', current, makeId)).toEqual({});
    expect(pathVariablesPatch('https://h/u', undefined, makeId)).toEqual({});
  });

  it('clears the rows when the last :name is removed', () => {
    const current: KeyValue[] = [{ id: 'a', key: 'id', value: '1', enabled: true }];
    expect(pathVariablesPatch('https://h/u', current, makeId)).toEqual({ pathVariables: [] });
  });
});
