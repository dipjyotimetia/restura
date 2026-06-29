import { describe, it, expect } from 'vitest';
import { mapHttpElementToSpec, resolveVars } from '../../src/offering3_codelens/ocRequestMapper';

const VARS = { API_BASE: 'https://api.example.com', TOKEN: 'abc123' };

describe('resolveVars', () => {
  it('substitutes known refs and leaves unknown ones intact', () => {
    expect(resolveVars('{{API_BASE}}/x/{{MISSING}}', VARS)).toBe(
      'https://api.example.com/x/{{MISSING}}'
    );
  });
});

describe('mapHttpElementToSpec', () => {
  it('maps method, url, enabled headers/params with var resolution', () => {
    const doc = {
      info: { type: 'http', name: 'r' },
      http: {
        method: 'GET',
        url: '{{API_BASE}}/posts',
        headers: [
          { name: 'Accept', value: 'application/json' },
          { name: 'X-Off', value: 'no', enabled: false },
        ],
        params: [{ name: 'q', value: 'hi' }],
      },
    };
    const { spec } = mapHttpElementToSpec(doc, VARS);
    expect(spec.url).toBe('https://api.example.com/posts');
    expect(spec.headers).toEqual({ Accept: 'application/json' });
    expect(spec.params).toEqual({ q: 'hi' });
  });

  it('applies bearer auth as an Authorization header with resolved vars', () => {
    const doc = {
      info: { type: 'http', name: 'r' },
      http: { method: 'GET', url: 'https://x', auth: { type: 'bearer', token: '{{TOKEN}}' } },
    };
    const { spec } = mapHttpElementToSpec(doc, VARS);
    expect(spec.headers?.['Authorization']).toBe('Bearer abc123');
  });

  it('applies basic auth as base64', () => {
    const doc = {
      info: { type: 'http', name: 'r' },
      http: {
        method: 'GET',
        url: 'https://x',
        auth: { type: 'basic', username: 'u', password: 'p' },
      },
    };
    const { spec } = mapHttpElementToSpec(doc, VARS);
    expect(spec.headers?.['Authorization']).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('maps a raw json body', () => {
    const doc = {
      info: { type: 'http', name: 'r' },
      http: {
        method: 'POST',
        url: 'https://x',
        body: { raw: { format: 'json', value: '{"a":1}' } },
      },
    };
    const { spec } = mapHttpElementToSpec(doc, VARS);
    expect(spec.bodyType).toBe('json');
    expect(spec.data).toBe('{"a":1}');
  });

  it('forwards awsv4 as wire-signed auth (renamed fields)', () => {
    const doc = {
      info: { type: 'http', name: 'r' },
      http: {
        method: 'GET',
        url: 'https://x',
        auth: {
          type: 'awsv4',
          accessKeyId: 'AK',
          secretAccessKey: 'SK',
          region: 'us-east-1',
          service: 's3',
        },
      },
    };
    const { spec } = mapHttpElementToSpec(doc, VARS);
    expect(spec.auth?.type).toBe('aws-signature');
    expect(spec.auth?.awsSignature?.accessKey).toBe('AK');
    expect(spec.auth?.awsSignature?.secretKey).toBe('SK');
  });

  it('warns on an unsupported auth type instead of throwing', () => {
    const doc = {
      info: { type: 'http', name: 'r' },
      http: {
        method: 'GET',
        url: 'https://x',
        auth: { type: 'digest', username: 'u', password: 'p' },
      },
    };
    const { warnings } = mapHttpElementToSpec(doc, VARS);
    expect(warnings.some((w) => w.includes('digest'))).toBe(true);
  });

  it('throws when method/url are missing', () => {
    expect(() => mapHttpElementToSpec({ info: { type: 'http' }, http: {} }, VARS)).toThrow();
  });
});
