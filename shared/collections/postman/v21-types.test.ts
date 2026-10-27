import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PostmanV21Auth, PostmanV21Collection, PostmanV21Item } from './v21-types';

interface SchemaNode {
  required?: string[];
  properties: Record<string, { enum?: string[] }>;
}
const schema = JSON.parse(
  readFileSync(resolve(process.cwd(), 'vendor/postman/v2.1.0/schema.json'), 'utf8')
) as SchemaNode & { definitions: Record<string, SchemaNode> };

describe('Postman v2.1 generated types', () => {
  it('accepts a collection with a folder and a request item', () => {
    const request: PostmanV21Item = {
      name: 'List',
      request: { method: 'GET', url: 'https://example.com/users' },
    };
    const collection: PostmanV21Collection = {
      info: {
        name: 'Demo',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [{ name: 'Users', item: [request] }],
    };
    expect(collection.item).toHaveLength(1);
  });

  it('auth type is a closed union', () => {
    const auth: PostmanV21Auth = { type: 'bearer', bearer: [{ key: 'token', value: 'x' }] };
    // @ts-expect-error jwt is off-schema
    const bad: PostmanV21Auth = { type: 'jwt' };
    expect([auth.type, bad.type]).toEqual(['bearer', 'jwt']);
  });

  it('vendored schema pins required fields and auth enum', () => {
    expect(schema.required).toEqual(['info', 'item']);
    expect(schema.definitions.info?.required).toEqual(['name', 'schema']);
    expect(schema.definitions.auth?.properties.type?.enum).toEqual([
      'apikey',
      'awsv4',
      'basic',
      'bearer',
      'digest',
      'edgegrid',
      'hawk',
      'noauth',
      'oauth1',
      'oauth2',
      'ntlm',
    ]);
  });
});
