import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { importOpenCollection } from '../importers/opencollection';

const FIXTURES = 'tests/fixtures/opencollection';

describe('importOpenCollection', () => {
  it('imports a parsed bundled OpenCollection document', () => {
    const raw = readFileSync(`${FIXTURES}/simple-http.yaml`, 'utf8');
    const data = yaml.load(raw);
    const result = importOpenCollection(data);
    expect(result.collection.name).toBe('Simple HTTP Demo');
    expect(result.collection.items.length).toBe(1);
    expect(result.collection.items[0]?.type).toBe('request');
    expect(result.warnings).toEqual([]);
  });

  it('throws a readable error on invalid input', () => {
    expect(() => importOpenCollection({ opencollection: '1.0.0', info: {} })).toThrow(
      /Invalid OpenCollection document/
    );
  });

  it('imports the multi-protocol fixture and surfaces SSE from extensions', () => {
    const raw = readFileSync(`${FIXTURES}/multi-protocol.yaml`, 'utf8');
    const data = yaml.load(raw);
    const result = importOpenCollection(data);
    const types = result.collection.items.map((i) => i.request?.type ?? `folder:${i.name}`);
    expect(types).toContain('http');
    expect(types).toContain('grpc');
    expect(types).toContain('sse');
  });

  it('materializes scripts and surfaces warnings for after-response/hooks', () => {
    const data = {
      opencollection: '1.0.0',
      info: { name: 'Scripted' },
      items: [
        {
          info: { type: 'http', name: 'With Pre + Test' },
          http: { method: 'GET', url: 'https://example.com' },
          runtime: {
            scripts: [
              { type: 'before-request', code: 'console.log("pre")' },
              { type: 'tests', code: 'pm.test("ok", () => {})' },
              { type: 'after-response', code: '/* dropped */' },
              { type: 'hooks', code: '/* dropped */' },
            ],
          },
        },
      ],
    };
    const result = importOpenCollection(data);
    const req = result.collection.items[0]?.request as
      { preRequestScript?: string; testScript?: string } | undefined;
    expect(req?.preRequestScript).toBe('console.log("pre")');
    expect(req?.testScript).toBe('pm.test("ok", () => {})');
    const dropped = result.warnings.filter((w) => w.kind === 'unrecognized-script-type');
    expect(dropped.length).toBe(2);
  });

  it('extracts additional environments beyond the first', () => {
    const data = {
      opencollection: '1.0.0',
      info: { name: 'Multi-Env' },
      config: {
        environments: [
          { name: 'dev', variables: [{ name: 'HOST', value: 'http://localhost' }] },
          { name: 'staging', variables: [{ name: 'HOST', value: 'https://staging.example' }] },
          { name: 'prod', variables: [{ name: 'HOST', value: 'https://example.com' }] },
        ],
      },
      items: [],
    };
    const result = importOpenCollection(data);
    expect(result.collection.variables?.[0]?.key).toBe('HOST'); // first env merged into Collection.variables (back-compat)
    expect(result.environments?.length).toBe(2); // staging + prod become standalone envs
    expect(result.environments?.map((e) => e.name)).toEqual(['staging', 'prod']);
  });

  it('keeps non-secret vars and preserves secret vars value-less in additional environments', () => {
    const data = {
      opencollection: '1.0.0',
      info: { name: 'Secret-Env' },
      config: {
        environments: [
          { name: 'dev', variables: [{ name: 'HOST', value: 'http://localhost' }] },
          {
            name: 'prod',
            variables: [
              { name: 'HOST', value: 'https://example.com', secret: false },
              { name: 'API_KEY', value: 'should-not-leak', secret: true },
            ],
          },
        ],
      },
      items: [],
    };
    const result = importOpenCollection(data);
    const prod = result.environments?.find((e) => e.name === 'prod');
    // secret:false must NOT be dropped (regression: `'secret' in v` dropped it)
    const host = prod?.variables.find((v) => v.key === 'HOST');
    expect(host?.value).toBe('https://example.com');
    // secret:true var is preserved as a value-less flagged entry, not leaked, not dropped
    const apiKey = prod?.variables.find((v) => v.key === 'API_KEY');
    expect(apiKey).toBeDefined();
    expect(apiKey?.value).toBe('');
    expect(apiKey?.secret).toBe(true);
  });
});
