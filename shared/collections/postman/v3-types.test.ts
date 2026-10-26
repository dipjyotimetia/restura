import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PostmanV3Collection } from './v3-types';

interface SchemaNode {
  required?: string[];
  properties: Record<string, { const?: string }>;
}
const schema = JSON.parse(
  readFileSync(resolve(process.cwd(), 'vendor/postman/v3.0.0/schema.json'), 'utf8')
) as SchemaNode & { definitions: Record<string, SchemaNode> };

describe('Postman v3 generated types', () => {
  it('accepts a collection with a folder and an http-request', () => {
    const collection: PostmanV3Collection = {
      $kind: 'collection',
      name: 'Demo',
      items: [
        {
          // Upstream quirk: v3-folder pins $kind to 'collection', not 'folder'.
          $kind: 'collection',
          name: 'Users',
          items: [
            {
              $kind: 'http-request',
              name: 'List',
              method: 'GET',
              url: 'https://example.com/users',
            },
          ],
        },
      ],
    };
    expect(collection.items).toHaveLength(1);
  });

  it('vendored schema pins $kind consts and required fields', () => {
    expect(schema.required).toEqual(['name', '$kind']);
    expect(schema.properties.$kind?.const).toBe('collection');
    expect(schema.definitions['v3-folder']?.properties.$kind?.const).toBe('collection');
    expect(schema.definitions['v3-http-request']?.properties.$kind?.const).toBe('http-request');
    expect(schema.definitions['v3-http-request']?.required).toEqual(['name', '$kind']);
  });
});
