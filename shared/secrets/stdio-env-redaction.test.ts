import { describe, expect, it } from 'vitest';
import { mcpStdioToOC } from '../opencollection/mcp-stdio-extension';
import type { Collection, McpRequest, McpStdioEnvVar } from '../types';
import { countCollectionInlineSecrets, redactCollectionSecrets } from './collection-redaction';
import {
  countStdioEnvInlineSecrets,
  redactOcStdioEnv,
  redactStdioEnvRows,
  stdioEnvOf,
} from './stdio-env-redaction';

const row = (key: string, value: string, extra: Partial<McpStdioEnvVar> = {}): McpStdioEnvVar => ({
  id: key,
  key,
  value,
  enabled: true,
  ...extra,
});

const env = [
  row('LOG_LEVEL', 'debug'),
  row('API_KEY', 'sk-live-123'),
  row('CUSTOM', 'flagged', { secret: true }),
  row('INLINE_REF', '', { secretRef: { kind: 'inline', value: 'plaintext-ref' } }),
  row('HANDLE_REF', '', { secretRef: { kind: 'handle', id: 'h-1', label: 'gh' } }),
];

describe('stdio env redaction', () => {
  it('blanks credential-named and flagged values, keeps handles, blanks inline refs', () => {
    const out = redactStdioEnvRows(env);
    expect(out[0]).toEqual(env[0]);
    expect(out[1]).toMatchObject({ value: '', secret: true });
    expect(out[2]).toMatchObject({ value: '', secret: true });
    expect(out[3]?.secretRef).toEqual({ kind: 'inline', value: '' });
    expect(out[4]?.secretRef).toEqual({ kind: 'handle', id: 'h-1', label: 'gh' });
    expect(JSON.stringify(out)).not.toMatch(/sk-live-123|flagged|plaintext-ref/);
  });

  it('counts remaining plaintext credentials', () => {
    expect(countStdioEnvInlineSecrets(env)).toBe(3);
    expect(countStdioEnvInlineSecrets(redactStdioEnvRows(env))).toBe(0);
    expect(countStdioEnvInlineSecrets(undefined)).toBe(0);
    expect(
      countStdioEnvInlineSecrets([
        row('X', '', {
          secretRef: {
            kind: 'external',
            provider: 'aws-secrets-manager',
            profileId: 'p',
            secretId: 's',
          },
        }),
      ])
    ).toBe(0);
  });

  it('handles string secretRefs, legacy key names and missing env', () => {
    expect(countStdioEnvInlineSecrets([row('A', '', { secretRef: 'plain-ref' })])).toBe(1);
    expect(countStdioEnvInlineSecrets([row('A', '', { secretRef: '' })])).toBe(0);
    expect(redactOcStdioEnv([{ key: 'PASSWORD', value: 'p' }, { value: 'x' }])).toEqual([
      { key: 'PASSWORD', value: '', secret: true },
      { value: 'x' },
    ]);
    expect(stdioEnvOf({})).toBeUndefined();
    expect(stdioEnvOf({ stdio: 'npx' })).toBeUndefined();
    expect(stdioEnvOf({ stdio: { command: 'srv' } })).toBeUndefined();
    expect(stdioEnvOf({ stdio: { env: [] } })).toEqual([]);
  });

  it('redacts the OpenCollection wire shape inside passthrough bags', () => {
    const out = redactOcStdioEnv([
      { name: 'API_TOKEN', value: 'tok' },
      { name: 'MODE', value: 'fast' },
      { name: 'X', value: '', secretRef: { kind: 'inline', value: 'p' } },
      { name: 'Y', value: '', secretRef: { kind: 'handle', id: 'h' } },
      null,
    ]);
    expect(out).toEqual([
      { name: 'API_TOKEN', value: '', secret: true },
      { name: 'MODE', value: 'fast' },
      { name: 'X', value: '' },
      { name: 'Y', value: '', secretRef: { kind: 'handle', id: 'h' } },
      null,
    ]);
  });

  it('the OC serializer is verbatim (like headers); redaction is the redaction layer’s job', () => {
    const verbatim = JSON.stringify(mcpStdioToOC({ command: 'srv', args: [], env }));
    expect(verbatim).toContain('sk-live-123');
    expect(verbatim).toContain('"secret":true');
    const redacted = JSON.stringify(
      mcpStdioToOC({ command: 'srv', args: [], env: redactStdioEnvRows(env) })
    );
    expect(redacted).not.toMatch(/sk-live-123|flagged|plaintext-ref/);
    expect(redacted).toContain('"debug"');
    expect(redacted).toContain('"h-1"');
  });

  it('collection export redaction and the inline-secret counter cover stdio.env', () => {
    const request: McpRequest = {
      id: 'm',
      name: 'Local',
      type: 'mcp',
      url: '',
      transport: 'stdio',
      stdio: { command: 'srv', args: [], env },
      headers: [],
      auth: { type: 'none' },
    };
    const bag = {
      info: { type: 'mcp', name: 'Local' },
      mcp: { stdio: { command: 'srv', env: [{ name: 'API_KEY', value: 'sk-live-123' }] } },
    };
    const collection = {
      id: 'c',
      name: 'C',
      items: [{ id: 'i', name: 'Local', type: 'request', request, _oc: bag }],
    } as unknown as Collection;
    expect(countCollectionInlineSecrets(collection)).toBeGreaterThanOrEqual(3);
    const redacted = redactCollectionSecrets(collection);
    expect(JSON.stringify(redacted)).not.toMatch(/sk-live-123|flagged|plaintext-ref/);
    expect(JSON.stringify(redacted)).toContain('"debug"');
    expect(countCollectionInlineSecrets(redacted)).toBe(0);
  });
});
