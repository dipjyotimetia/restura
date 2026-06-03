import { describe, it, expect } from 'vitest';
import { summarizeOpenApi, parseGeneratedCases, buildGenMessages } from '../openapiTestGen';
import type { CompletionResult } from '@shared/protocol/ai/types';

const SPEC = {
  info: { title: 'Pet Store' },
  paths: {
    '/pets': {
      get: { summary: 'List pets', parameters: [{ name: 'limit' }] },
      post: { summary: 'Create pet' },
    },
    '/pets/{id}': {
      get: { summary: 'Get pet', parameters: [{ name: 'id' }] },
      // non-method key should be ignored
      parameters: [{ name: 'id' }],
    },
  },
};

describe('summarizeOpenApi', () => {
  it('extracts operations, methods, summaries, and params', () => {
    const s = summarizeOpenApi(SPEC);
    expect(s.title).toBe('Pet Store');
    const get = s.operations.find((o) => o.method === 'GET' && o.path === '/pets');
    expect(get?.summary).toBe('List pets');
    expect(get?.params).toEqual(['limit']);
    // 'parameters' under /pets/{id} is not an HTTP method → not an operation
    expect(s.operations.filter((o) => o.path === '/pets/{id}')).toHaveLength(1);
  });

  it('handles an empty / malformed spec', () => {
    expect(summarizeOpenApi(null).operations).toEqual([]);
    expect(summarizeOpenApi({}).title).toBe('API');
  });
});

describe('buildGenMessages', () => {
  it('lists operations and the requested count', () => {
    const [, user] = buildGenMessages({ summary: summarizeOpenApi(SPEC), count: 7 });
    expect(user?.content).toContain('GET /pets');
    expect(user?.content).toContain('Generate 7 test cases');
  });
});

describe('parseGeneratedCases', () => {
  function completion(over: Partial<CompletionResult>): CompletionResult {
    return { ok: true, text: '', toolCalls: [], ...over };
  }

  it('parses cases from the tool call and coerces non-string vars', () => {
    const cases = parseGeneratedCases(
      completion({
        toolCalls: [
          {
            id: '1',
            name: 'submit_dataset',
            input: JSON.stringify({
              cases: [
                { vars: { limit: 5 }, expected: 'ok' },
                { vars: { id: 'a' }, reference: 'pet A' },
              ],
            }),
          },
        ],
      })
    );
    expect(cases).toHaveLength(2);
    expect(cases[0]).toEqual({ vars: { limit: '5' }, expected: 'ok' });
    expect(cases[1]).toEqual({ vars: { id: 'a' }, reference: 'pet A' });
  });

  it('returns [] on unparseable output', () => {
    expect(parseGeneratedCases(completion({ text: 'no json' }))).toEqual([]);
  });
});
