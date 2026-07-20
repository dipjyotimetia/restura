import { describe, expect, it } from 'vitest';
import { isOwsBindings, isOwsTaskBinding } from '../bindings';

describe('OWS bindings', () => {
  it('accepts an exact resource reference binding', () => {
    expect(isOwsTaskBinding({ kind: 'saved-request', call: 'http', resourceId: 'request-1' })).toBe(
      true
    );
    expect(
      isOwsBindings({
        version: 1,
        tasks: {
          '/do/0/request': { kind: 'saved-request', call: 'http', resourceId: 'request-1' },
        },
      })
    ).toBe(true);
  });

  it.each([
    [
      'environment variables',
      { version: 1, tasks: {}, environment: { TOKEN: 'plaintext-secret' } },
    ],
    [
      'inline credentials on a task binding',
      {
        version: 1,
        tasks: {
          '/do/0/request': {
            kind: 'saved-request',
            call: 'http',
            resourceId: 'request-1',
            headers: { authorization: 'Bearer plaintext-secret' },
          },
        },
      },
    ],
    ['extra root fields', { version: 1, tasks: {}, credentials: 'plaintext-secret' }],
    [
      'non-reference resource identifiers',
      { kind: 'saved-request', call: 'http', resourceId: 'Bearer plaintext-secret' },
    ],
    [
      'a binding whose declared call does not match its resource kind',
      { kind: 'saved-request', call: 'mcp', resourceId: 'request-1' },
    ],
  ])('rejects %s', (_name, value) => {
    if ('kind' in value) {
      expect(isOwsTaskBinding(value)).toBe(false);
    } else {
      expect(isOwsBindings(value)).toBe(false);
    }
  });
});
