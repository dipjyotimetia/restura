import { describe, expect, it } from 'vitest';
import type { Collection } from '@/types';
import { buildDocModel, docModelToHtml, docModelToMarkdown, escapeHtml } from '../docGenerator';

function kv(
  key: string,
  value: string,
  extra: Partial<{ description: string; secret: boolean }> = {}
) {
  return { id: `${key}-id`, key, value, enabled: true, ...extra };
}

const collection: Collection = {
  id: 'c1',
  name: 'My API',
  description: 'Test collection',
  items: [
    {
      id: 'f1',
      name: 'Users',
      type: 'folder',
      items: [
        {
          id: 'r1',
          name: 'Get user',
          type: 'request',
          request: {
            id: 'r1',
            name: 'Get user',
            type: 'http',
            method: 'GET',
            url: 'https://api.example/users/1',
            headers: [kv('Accept', 'application/json'), kv('X-Disabled', 'x', {})],
            params: [kv('expand', 'profile', { description: 'include profile' })],
            body: { type: 'none' },
            auth: { type: 'bearer', bearer: { token: 't' } } as never,
          },
        },
        {
          id: 'r2',
          name: 'Create user',
          type: 'request',
          request: {
            id: 'r2',
            name: 'Create user',
            type: 'http',
            method: 'POST',
            url: 'https://api.example/users',
            headers: [],
            params: [],
            body: { type: 'json', raw: '{"name":"<x>"}' },
            auth: { type: 'none' } as never,
          },
        },
      ],
    },
  ],
};

describe('request description', () => {
  it('carries HttpRequest.description into the doc model and rendered markdown', () => {
    const withDesc: Collection = {
      id: 'c2',
      name: 'Docs API',
      items: [
        {
          id: 'r1',
          name: 'Ping',
          type: 'request',
          request: {
            id: 'r1',
            name: 'Ping',
            type: 'http',
            method: 'GET',
            url: 'https://api.example/ping',
            headers: [],
            params: [],
            body: { type: 'none' },
            auth: { type: 'none' } as never,
            description: 'Returns pong. AI-enriched docs.',
          },
        },
      ],
    };
    const model = buildDocModel(withDesc);
    expect(model.operations[0]?.description).toBe('Returns pong. AI-enriched docs.');
    expect(docModelToMarkdown(model)).toContain('Returns pong. AI-enriched docs.');
  });
});

describe('buildDocModel', () => {
  it('flattens folders into operations with paths', () => {
    const model = buildDocModel(collection);
    expect(model.title).toBe('My API');
    expect(model.operations).toHaveLength(2);
    expect(model.operations[0]).toMatchObject({
      method: 'GET',
      path: 'Users',
      name: 'Get user',
      authType: 'bearer',
    });
  });

  it('includes only enabled key-values', () => {
    const model = buildDocModel(collection);
    const op = model.operations[0]!;
    expect(op.headers.map((h) => h.name)).toEqual(['Accept', 'X-Disabled']);
    expect(op.params[0]).toMatchObject({ name: 'expand', description: 'include profile' });
  });

  it('captures body type and raw body', () => {
    const model = buildDocModel(collection);
    const post = model.operations[1]!;
    expect(post.bodyType).toBe('json');
    expect(post.body).toBe('{"name":"<x>"}');
  });
});

describe('docModelToMarkdown', () => {
  it('renders endpoint sections', () => {
    const md = docModelToMarkdown(buildDocModel(collection));
    expect(md).toContain('# My API');
    expect(md).toContain('### GET — Users / Get user');
    expect(md).toContain('GET https://api.example/users/1');
    expect(md).toContain('**Auth:** `bearer`');
  });
});

describe('docModelToHtml', () => {
  it('escapes user content to prevent injection', () => {
    const html = docModelToHtml(buildDocModel(collection));
    expect(html).toContain('&lt;x&gt;');
    expect(html).not.toContain('<x>');
    expect(html).toContain('<title>My API — API docs</title>');
  });
});

describe('escapeHtml', () => {
  it('escapes the dangerous characters', () => {
    expect(escapeHtml('<a href="x">&')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;');
  });
});
