import { describe, expect, it } from 'vitest';
import type { AuthConfig, HttpRequest } from '@/types';
import { generateCurl } from './curl';
import { generateJavaScript } from './javascript';
import { type CodegenInput, prepareCodegen, withNotes } from './prepare';
import { generatePython } from './python';

const base: HttpRequest = {
  id: 'r',
  name: 'r',
  type: 'http',
  method: 'POST',
  url: 'https://{{host}}/items',
  headers: [
    { id: 'h1', key: 'X-Token', value: '{{token}}', enabled: true },
    { id: 'h2', key: 'X-Off', value: 'x', enabled: false },
  ],
  params: [{ id: 'p1', key: 'q', value: '{{term}}', enabled: true }],
  body: { type: 'json', raw: '{"host":"{{host}}"}' },
  auth: { type: 'none' },
};

const input = (over: Partial<CodegenInput> = {}): CodegenInput => ({
  request: base,
  auth: { type: 'none' },
  values: { host: 'api.dev', token: 's3cret', term: 'shoes' },
  secretNames: new Set(['token']),
  maskSecrets: true,
  ...over,
});

describe('prepareCodegen', () => {
  it('resolves variables from all scopes and keeps masked secrets as references', () => {
    const out = prepareCodegen(input());
    expect(out.resolvedUrl).toBe('https://api.dev/items');
    expect(out.resolvedParams).toEqual({ q: 'shoes' });
    expect(out.resolvedHeaders).toEqual({ 'X-Token': '{{token}}' });
    expect(out.request.body.raw).toBe('{"host":"api.dev"}');
    expect(out.notes).toEqual([]);
  });

  it('prints secrets only when unmasked, and never for desktop handles', () => {
    expect(prepareCodegen(input({ maskSecrets: false })).resolvedHeaders['X-Token']).toBe('s3cret');
    const handle = input({ maskSecrets: false, values: { host: 'api.dev', term: 'x' } });
    expect(prepareCodegen(handle).resolvedHeaders['X-Token']).toBe('{{token}}');
  });

  const auth = (a: AuthConfig, maskSecrets = false) =>
    prepareCodegen(input({ auth: a, maskSecrets }));

  it('folds header-style auth into the snippet', () => {
    expect(
      auth({ type: 'basic', basic: { username: 'u', password: 'p' } }).resolvedHeaders.Authorization
    ).toBe(`Basic ${btoa('u:p')}`);
    expect(
      auth({ type: 'basic', basic: { username: 'u', password: 'p' } }, true).resolvedHeaders
        .Authorization
    ).toBe('Basic <base64(username:password)>');
    expect(auth({ type: 'bearer', bearer: { token: 'tok' } }).resolvedHeaders.Authorization).toBe(
      'Bearer tok'
    );
    expect(
      auth({ type: 'bearer', bearer: { token: { kind: 'handle', id: 'h' } } }).resolvedHeaders
        .Authorization
    ).toBe('Bearer <token>');
    expect(
      auth({ type: 'oauth2', oauth2: { accessToken: 'at', tokenType: 'MAC' } }).resolvedHeaders
        .Authorization
    ).toBe('MAC at');
  });

  it('places API keys in a header or the query, and never overrides a user header', () => {
    const header = auth({ type: 'api-key', apiKey: { key: 'X-Key', value: 'k', in: 'header' } });
    expect(header.resolvedHeaders['X-Key']).toBe('k');
    const query = auth({ type: 'api-key', apiKey: { key: 'key', value: 'k', in: 'query' } }, true);
    expect(query.resolvedParams.key).toBe('<api-key>');
    const userAuth = prepareCodegen(
      input({
        request: {
          ...base,
          headers: [{ id: 'a', key: 'authorization', value: 'Custom', enabled: true }],
        },
        auth: { type: 'bearer', bearer: { token: 't' } },
      })
    );
    expect(userAuth.resolvedHeaders).toEqual({ authorization: 'Custom' });
  });

  it('explains auth and bodies a snippet cannot reproduce', () => {
    expect(auth({ type: 'oauth1' } as AuthConfig).notes[0]).toMatch(/OAuth 1\.0 auth is computed/);
    expect(auth({ type: 'oauth2', oauth2: { accessToken: '' } }).notes[0]).toMatch(
      /no access token/
    );
    const binary = prepareCodegen(
      input({ request: { ...base, body: { type: 'binary', raw: 'AAA=' } } })
    );
    expect(binary.notes[0]).toMatch(/binary body/);
    expect(binary.request.body.raw).toBe('AAA=');
  });

  it('expands enabled form-data fields, resolving text and naming files', () => {
    const out = prepareCodegen(
      input({
        request: {
          ...base,
          body: {
            type: 'form-data',
            formData: [
              { id: '1', key: 'name', value: '{{term}}', enabled: true, type: 'text' },
              {
                id: '2',
                key: 'doc',
                value: 'QUJD',
                enabled: true,
                type: 'file',
                fileName: 'a.pdf',
              },
              { id: '3', key: 'off', value: 'x', enabled: false, type: 'text' },
            ],
          },
        },
      })
    );
    expect(out.formData).toEqual([
      { key: 'name', value: 'shoes', type: 'text' },
      { key: 'doc', value: 'a.pdf', type: 'file' },
    ]);
    expect(generateCurl(out)).toContain("-F 'doc=@a.pdf'");
    expect(generatePython(out)).toContain('files=files');
    expect(generateJavaScript(out)).toContain('body: form');
  });
});

describe('prepareCodegen bodies', () => {
  it('serializes urlencoded fields and adds the XML Content-Type the app sends', () => {
    const form = prepareCodegen(
      input({
        request: {
          ...base,
          body: {
            type: 'x-www-form-urlencoded',
            formData: [
              { id: '1', key: 'q', value: '{{term}} x', enabled: true, type: 'text' },
              { id: '2', key: 'off', value: 'y', enabled: false, type: 'text' },
            ],
          },
        },
      })
    );
    expect(form.request.body.raw).toBe('q=shoes%20x');
    const xml = prepareCodegen(input({ request: { ...base, body: { type: 'xml', raw: '<a/>' } } }));
    expect(xml.resolvedHeaders['Content-Type']).toBe('application/xml');
  });
});

describe('generators', () => {
  it('JavaScript stringifies JSON bodies for fetch', () => {
    expect(generateJavaScript(prepareCodegen(input()))).toContain(
      'body: JSON.stringify({"host":"api.dev"})'
    );
  });
});

describe('withNotes', () => {
  it('prepends notes as comments, inside the <?php block for PHP', () => {
    expect(withNotes('curl x', 'curl', ['a'])).toBe('# Note: a\ncurl x');
    expect(withNotes('<?php\necho 1;', 'php', ['a'])).toBe('<?php\n// Note: a\necho 1;');
    expect(withNotes('x', 'go', [])).toBe('x');
  });
});
