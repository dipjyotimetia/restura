import {
  redactEnvironmentVariables,
  redactSecretsDeep,
  redactUrlCredentials,
} from '@shared/mcp-server/redaction';
import { internalToOC } from '@shared/opencollection/from-internal';
import { ocToInternal } from '@shared/opencollection/to-internal';
import {
  countCollectionInlineSecrets,
  redactCollectionSecrets,
} from '@shared/secrets/collection-redaction';
import type {
  Collection,
  CollectionItem,
  Environment,
  KafkaRequest,
  MqttRequest,
} from '@shared/types';
import { describe, expect, it } from 'vitest';
import { exportBrunoCollection } from '@/features/collections/lib/bruno-exporter';
import { buildDocModel, docModelToMarkdown } from '@/features/collections/lib/docGenerator';
import {
  exportToOpenCollection,
  getCollectionExportWarnings,
} from '@/features/collections/lib/exporters';
import { entriesToHar } from '@/lib/shared/console-export';
import { sanitizeConsoleUrl } from '@/lib/shared/console-sanitization';
import type { ConsoleEntry } from '@/store/useConsoleStore';

/** Every string containing PLAIN is a fake credential. */

const row = (key: string, value: string, extra: Record<string, unknown> = {}) => ({
  id: key,
  key,
  value,
  enabled: true,
  ...extra,
});

function brunoContent(exported: Awaited<ReturnType<typeof exportBrunoCollection>>): string {
  if (exported.kind !== 'directory') throw new Error('expected directory output');
  return exported.entries.map((e) => e.content).join('\n');
}

describe('Bruno export variables', () => {
  const collection = {
    id: 'c',
    name: 'c',
    items: [],
    variables: [
      row('flagged', 'PLAIN-flagged', { secret: true }),
      row('inlineRef', '', { secretRef: { kind: 'inline', value: 'PLAIN-ref' } }),
      row('private', 'PLAIN-private', { private: true }),
      row('plain', 'kept-value'),
    ],
  } as unknown as Collection;
  const environments = [
    {
      id: 'e',
      name: 'dev',
      variables: [
        row('flagged', 'PLAIN-env-flagged', { secret: true }),
        row('inlineRef', 'PLAIN-env-ref', {
          secretRef: { kind: 'inline', value: 'PLAIN-env-ref' },
        }),
        row('private', 'PLAIN-env-private', { private: true }),
        row('plain', 'kept-env-value'),
      ],
    },
  ] as unknown as Environment[];

  it('writes no secret or private value and keeps plain values', async () => {
    const exported = await exportBrunoCollection(collection, { environments });
    const content = brunoContent(exported);
    expect(content).not.toContain('PLAIN');
    expect(content).toContain('kept-value');
    expect(content).toContain('kept-env-value');
    expect(content).toContain('flagged');
  });

  it('reports the variables it left blank, by name and never by value', async () => {
    const exported = await exportBrunoCollection(collection, { environments });
    const omitted = exported.warnings.filter((w) => w.kind === 'secret-value-omitted');
    expect(omitted.map((w) => w.path)).toEqual(['collection.bru', 'environments/dev.bru']);
    expect(JSON.stringify(omitted)).not.toContain('PLAIN');
  });

  it('adds no warning when nothing was left blank', async () => {
    const exported = await exportBrunoCollection({
      ...collection,
      variables: [row('plain', 'kept-value')],
    } as unknown as Collection);
    expect(exported.warnings).toEqual([]);
  });

  it('secret variables raise the export count, and redaction clears it', () => {
    expect(countCollectionInlineSecrets(collection)).toBe(2);
    const redacted = redactCollectionSecrets(collection);
    expect(countCollectionInlineSecrets(redacted)).toBe(0);
    expect(redacted.variables?.find((v) => v.key === 'flagged')).toMatchObject({
      value: '',
      secret: true,
    });
    expect(redacted.variables?.find((v) => v.key === 'plain')?.value).toBe('kept-value');
  });

  it('a handle reference is kept and not counted', () => {
    const handle = { kind: 'handle', id: 'h' };
    const c = {
      id: 'c',
      name: 'c',
      items: [],
      variables: [row('h', '', { secretRef: handle })],
    } as unknown as Collection;
    expect(countCollectionInlineSecrets(c)).toBe(0);
    expect(redactCollectionSecrets(c).variables?.[0]).toMatchObject({ secretRef: handle });
  });
});

describe('MCP tool output URLs', () => {
  it.each([
    ['{{scheme}}://u:PLAIN@host', '{{scheme}}://host'],
    ['//u:PLAIN@host', '//host'],
    ['{{base}}/x?api_key=PLAIN', '{{base}}/x?api_key=%28secret%29'],
    ['user:PLAIN@host:50051', 'host:50051'],
    [' https://u:PLAIN@host', 'https://host'],
    ['https:u:PLAIN@host', 'https:host'],
    ['https://host#token=PLAIN', 'https://host#token=%28secret%29'],
  ])('%s becomes %s', (url, expected) => {
    expect(redactUrlCredentials(url)).toBe(expected);
  });

  it('covers every credential-named query value on a parsed URL', () => {
    const out = redactUrlCredentials(
      'https://h.test/p?client_secret=PLAIN&refresh_token=PLAIN&a=1'
    );
    expect(out).not.toContain('PLAIN');
    expect(out).toContain('a=1');
  });

  it('leaves ordinary values alone', () => {
    expect(redactUrlCredentials('{{base}}/users/a@b')).toBe('{{base}}/users/a@b');
    expect(redactUrlCredentials('mailto:a@b.test')).toBe('mailto:a@b.test');
  });
});

describe('variables', () => {
  const VARIABLES = [
    row('API_TOKEN', 'PLAIN-token'),
    row('dbPass', 'PLAIN-pass'),
    row('BASE_URL', 'https://u:PLAIN@h.test/p?token=PLAIN'),
    row('DSN', 'user:kept@db:5432'),
    row('AUTH_URL', 'https://idp.test/auth'),
    row('TOKEN_URI', 'https://idp.test/token'),
    row('PUBLIC_KEY', 'kept-public'),
    row('APP_PUBLIC_KEY', 'kept-app-public'),
    row('CACHE_KEY', 'kept-cache'),
    row('token_type', 'kept-type'),
    row('ref_token', '{{vault_token}}'),
    row('email', 'someone@example.test'),
    row('note', 'free text a:b@c here'),
    row('plain', 'kept-value'),
  ];
  const KEPT = [
    'https://h.test/p?token=',
    'user:kept@db:5432',
    'https://idp.test/auth',
    'https://idp.test/token',
    'kept-public',
    'kept-app-public',
    'kept-cache',
    'kept-type',
    '{{vault_token}}',
    'someone@example.test',
    'free text a:b@c here',
    'kept-value',
  ];
  const withVariables = {
    id: 'c',
    name: 'c',
    variables: VARIABLES,
    items: [{ id: 'f', name: 'folder', type: 'folder', items: [], variables: VARIABLES }],
  } as unknown as Collection;

  it('are blanked and stripped at collection and folder scope, and counted', () => {
    expect(countCollectionInlineSecrets(withVariables)).toBe(6);
    const out = redactCollectionSecrets(withVariables);
    expect(JSON.stringify(out)).not.toContain('PLAIN');
    const text = JSON.stringify(out.variables);
    for (const kept of KEPT) expect(text).toContain(JSON.stringify(kept));
    expect(countCollectionInlineSecrets(out)).toBe(0);
  });

  it('reach no OpenCollection file, with or without an unredacted collection', () => {
    const environment = {
      id: 'e',
      name: 'dev',
      collectionId: 'c',
      variables: VARIABLES,
    } as unknown as Environment;
    const yaml = exportToOpenCollection(
      { id: 'c', name: 'c', items: [] } as unknown as Collection,
      [environment]
    );
    expect(yaml).not.toContain('PLAIN');
    expect(yaml).toContain('kept-public');
  });

  it('reach no Bruno file, and are reported', async () => {
    const exported = await exportBrunoCollection(
      { id: 'c', name: 'c', items: [], variables: VARIABLES } as unknown as Collection,
      { environments: [{ id: 'e', name: 'dev', variables: VARIABLES } as unknown as Environment] }
    );
    const content = brunoContent(exported);
    expect(content).not.toContain('PLAIN');
    expect(content).toContain('kept-cache');
    const omitted = exported.warnings.filter((w) => w.kind === 'secret-value-omitted');
    expect(omitted.map((w) => w.path)).toEqual(['collection.bru', 'environments/dev.bru']);
    expect(omitted[0]?.message).toContain('API_TOKEN');
    expect(omitted[0]?.message).toContain('BASE_URL');
    expect(JSON.stringify(omitted)).not.toContain('PLAIN');
  });

  it('warn on an export that carries environments', () => {
    const c = { id: 'c', name: 'c', items: [] } as unknown as Collection;
    const env = (variables: unknown[]) =>
      ({ id: 'e', name: 'dev', collectionId: 'c', variables }) as unknown as Environment;
    expect(getCollectionExportWarnings(c, 'opencollection', [env(VARIABLES)])).toEqual([
      expect.stringMatching(/environment/i),
    ]);
    expect(getCollectionExportWarnings(c, 'opencollection', [env([row('a', 'b')])])).toEqual([]);
    expect(getCollectionExportWarnings(c, 'opencollection')).toEqual([]);
  });

  it('follow one policy in tool output, with the same exemptions', () => {
    const out = redactEnvironmentVariables(VARIABLES);
    expect(JSON.stringify(out)).not.toContain('PLAIN');
    const byKey = new Map(out.map((v) => [v.key, v]));
    expect(byKey.get('API_TOKEN')).toEqual({ key: 'API_TOKEN', value: '(secret)', isSecret: true });
    expect(byKey.get('DSN')).toEqual({ key: 'DSN', value: 'user:kept@db:5432', isSecret: false });
    for (const key of ['PUBLIC_KEY', 'CACHE_KEY', 'token_type', 'AUTH_URL', 'email']) {
      expect(byKey.get(key)?.isSecret).toBe(false);
    }
    const forms = redactEnvironmentVariables([row('c', ' https://u:PLAIN@h')]);
    expect(JSON.stringify(forms)).not.toContain('PLAIN');
  });

  it('in a passthrough bag follow the same policy', () => {
    const c = {
      id: 'c',
      name: 'c',
      items: [],
      _oc: {
        config: {
          environments: [
            {
              name: 'e',
              variables: [
                { name: 'API_KEY', value: 'PLAIN' },
                { name: 'BASE_URL', value: 'https://u:PLAIN@h.test' },
                { name: 'region', value: 'kept-region' },
              ],
            },
          ],
        },
      },
    } as unknown as Collection;
    expect(countCollectionInlineSecrets(c)).toBe(2);
    const out = redactCollectionSecrets(c);
    expect(JSON.stringify(out)).not.toContain('PLAIN');
    expect(JSON.stringify(out)).toContain('kept-region');
    expect(countCollectionInlineSecrets(out)).toBe(0);
  });
});

describe('remaining URL fields', () => {
  it('OAuth redirect and issuer values are covered', () => {
    const c = {
      id: 'c',
      name: 'c',
      auth: {
        type: 'oauth2',
        oauth2: {
          redirectUri: 'https://u:PLAIN@app.test/cb',
          issuer: 'https://u:PLAIN@idp.test',
        },
      },
      items: [],
    } as unknown as Collection;
    expect(countCollectionInlineSecrets(c)).toBe(2);
    const out = redactCollectionSecrets(c);
    expect(out.auth?.oauth2).toMatchObject({
      redirectUri: 'https://app.test/cb',
      issuer: 'https://idp.test',
    });
    expect(countCollectionInlineSecrets(out)).toBe(0);
  });

  it('Postman URL variables and Location headers are covered in every shape', () => {
    const c = {
      id: 'c',
      name: 'c',
      items: [
        {
          id: 'f',
          name: 'f',
          type: 'folder',
          items: [],
          _postman: {
            urlVariable: [
              { key: 'base', value: 'https://u:PLAIN@h.test' },
              { key: 'id', value: 'kept-id' },
            ],
            variable: [{ key: 'base', value: 'https://u:PLAIN@h.test' }],
            response: [
              { header: [{ key: 'Location', value: 'https://u:PLAIN@a.test/x' }] },
              { header: { location: 'https://h.test/x?token=PLAIN', Accept: 'kept-accept' } },
              { header: 'Location: https://u:PLAIN@b.test/y\nAccept: kept-line' },
            ],
          },
        },
      ],
    } as unknown as Collection;
    expect(countCollectionInlineSecrets(c)).toBe(5);
    const out = redactCollectionSecrets(c);
    const text = JSON.stringify(out);
    expect(text).not.toContain('PLAIN');
    for (const kept of ['kept-id', 'kept-accept', 'kept-line', 'https://a.test/x']) {
      expect(text).toContain(kept);
    }
    expect(countCollectionInlineSecrets(out)).toBe(0);
  });
});

describe('MCP deep result pass', () => {
  it('redacts known URL fields at any depth', () => {
    const out = redactSecretsDeep({
      url: '{{scheme}}://u:PLAIN@h.test',
      nested: {
        oauth2: {
          tokenUrl: 'https://u:PLAIN@idp.test/t',
          authorizationUrl: 'https://idp.test/a?client_secret=PLAIN',
        },
        contractSpec: { source: 'url', url: 'https://u:PLAIN@spec.test' },
        list: [{ brokerUrl: 'mqtt://u:PLAIN@b.test' }, { endpoint: '//u:PLAIN@e.test' }],
      },
      description: 'kept text',
    });
    expect(JSON.stringify(out)).not.toContain('PLAIN');
    expect(JSON.stringify(out)).toContain('kept text');
  });

  it('returns the same object when no URL field holds a credential', () => {
    const clean = { url: 'https://h.test', nested: { tokenUrl: '{{base}}/t' }, n: 1 };
    expect(redactSecretsDeep(clean)).toBe(clean);
  });

  it('a clean absolute URL is not rewritten', () => {
    expect(redactUrlCredentials('https://h.test')).toBe('https://h.test');
  });

  it('masks a credential-named environment value that is not flagged secret', () => {
    const out = redactEnvironmentVariables([
      { key: 'API_TOKEN', value: 'PLAIN-token' },
      { key: 'dbPassword', value: 'PLAIN-password' },
      { key: 'templated_token', value: 'PLAIN-{{suffix}}' },
      { key: 'ref_token', value: '{{vault_token}}' },
      { key: 'spaced_token', value: ' {{ vault_token }} ' },
      { key: 'page_token', value: 'cursor-kept' },
      { key: 'region', value: 'kept-region' },
    ]);
    expect(JSON.stringify(out)).not.toContain('PLAIN');
    const byKey = new Map(out.map((v) => [v.key, v]));
    expect(byKey.get('API_TOKEN')).toEqual({ key: 'API_TOKEN', value: '(secret)', isSecret: true });
    expect(byKey.get('ref_token')?.value).toBe('{{vault_token}}');
    expect(byKey.get('spaced_token')?.value).toBe(' {{ vault_token }} ');
    expect(byKey.get('page_token')?.value).toBe('cursor-kept');
    expect(byKey.get('region')).toEqual({ key: 'region', value: 'kept-region', isSecret: false });
  });

  it('an environment variable holding a URL is redacted, and other values kept', () => {
    const out = redactEnvironmentVariables([
      { key: 'base', value: 'https://u:PLAIN@h.test/p?token=PLAIN' },
      { key: 'templated', value: '{{scheme}}://u:PLAIN@h.test' },
      { key: 'email', value: 'someone@example.test' },
      { key: 'plain', value: 'kept-value' },
    ]);
    expect(JSON.stringify(out)).not.toContain('PLAIN');
    expect(out.find((v) => v.key === 'email')?.value).toBe('someone@example.test');
    expect(out.find((v) => v.key === 'plain')?.value).toBe('kept-value');
  });
});

describe('generated docs', () => {
  const request = (name: string, fields: Record<string, unknown>) =>
    ({
      id: name,
      name,
      type: 'request',
      request: { id: name, name, ...fields },
    }) as unknown as CollectionItem;
  const collection = {
    id: 'c',
    name: 'c',
    items: [
      request('http', {
        type: 'http',
        method: 'GET',
        url: 'https://u:PLAIN@api.test/p?access_token=PLAIN&page=1',
        headers: [row('Authorization', 'PLAIN-header'), row('Accept', 'kept-accept')],
        params: [row('api_key', 'PLAIN-param'), row('page', '1')],
      }),
      request('sse', { type: 'sse', url: '{{scheme}}://u:PLAIN@sse.test', headers: [] }),
    ],
  } as unknown as Collection;

  it('hold no URL or named credential, and keep the rest', () => {
    const markdown = docModelToMarkdown(buildDocModel(collection));
    expect(markdown).not.toContain('PLAIN');
    expect(markdown).toContain('https://api.test/p?access_token=&page=1');
    expect(markdown).toContain('kept-accept');
  });
});

describe('collection-scope URLs', () => {
  it('blanks a contract spec URL on the collection and on a folder', () => {
    const c = {
      id: 'c',
      name: 'c',
      contractSpec: { source: 'url', url: 'https://u:PLAIN@spec.test/c?token=PLAIN' },
      items: [
        {
          id: 'f',
          name: 'f',
          type: 'folder',
          items: [],
          contractSpec: { source: 'url', url: 'https://u:PLAIN@spec.test/f' },
        },
      ],
    } as unknown as Collection;
    expect(countCollectionInlineSecrets(c)).toBe(3);
    const out = redactCollectionSecrets(c);
    expect(out.contractSpec?.url).toBe('https://spec.test/c?token=');
    expect(out.items[0]?.contractSpec?.url).toBe('https://spec.test/f');
    expect(countCollectionInlineSecrets(out)).toBe(0);
  });

  it('blanks OAuth endpoint URLs at every auth scope and keeps clean ones', () => {
    const oauth2 = {
      tokenUrl: 'https://u:PLAIN@idp.test/token',
      authorizationUrl: 'https://idp.test/auth',
    };
    const auth = { type: 'oauth2', oauth2 };
    const c = {
      id: 'c',
      name: 'c',
      auth,
      items: [{ id: 'f', name: 'f', type: 'folder', items: [], auth }],
    } as unknown as Collection;
    expect(countCollectionInlineSecrets(c)).toBe(2);
    const out = redactCollectionSecrets(c);
    expect(out.auth?.oauth2).toMatchObject({
      tokenUrl: 'https://idp.test/token',
      authorizationUrl: 'https://idp.test/auth',
    });
    expect(JSON.stringify(out)).not.toContain('PLAIN');
    expect(countCollectionInlineSecrets(out)).toBe(0);
  });
});

describe('passthrough bags', () => {
  it('sanitise address keys in an opaque item', () => {
    const c = {
      id: 'c',
      name: 'c',
      items: [
        {
          id: 'p',
          name: 'p',
          type: 'folder',
          items: [],
          _oc: {
            info: { type: 'future-protocol' },
            brokerUrl: 'mqtt://u:PLAIN@broker.test',
            endpoint: 'https://u:PLAIN@host/e?token=PLAIN',
            auth: { type: 'oauth2', tokenUrl: 'https://u:PLAIN@idp.test' },
          },
        },
      ],
    } as unknown as Collection;
    expect(countCollectionInlineSecrets(c)).toBe(4);
    const out = redactCollectionSecrets(c);
    expect((out.items[0] as unknown as { _oc: unknown })._oc).toMatchObject({
      brokerUrl: 'mqtt://broker.test',
      endpoint: 'https://host/e?token=',
      auth: { tokenUrl: 'https://idp.test' },
    });
    expect(countCollectionInlineSecrets(out)).toBe(0);
  });

  it('do not re-emit broker values after an OpenCollection round trip', () => {
    const kafka = {
      id: 'k',
      name: 'k',
      type: 'kafka',
      connection: {
        bootstrapBrokers: ['u:PLAIN@b1:9092'],
        clientId: 'c',
        securityProtocol: 'SASL_SSL',
        sasl: { mechanism: 'OAUTHBEARER', extensions: { token: 'PLAIN-ext', cluster: 'kept' } },
        registry: { url: 'https://u:PLAIN@registry.test' },
        acks: 1,
        compression: 'none',
        idempotent: false,
      },
      produce: {
        topic: 't',
        key: '',
        keyEncoding: 'utf8',
        value: '',
        valueEncoding: 'utf8',
        headers: [],
      },
      consume: { groupId: 'g', topics: [], mode: 'committed' },
    } as unknown as KafkaRequest;
    const mqtt = {
      id: 'm',
      name: 'm',
      type: 'mqtt',
      connection: {
        brokerUrl: 'mqtt://u:PLAIN@broker.test',
        protocolVersion: 5,
        clientId: 'c',
        keepalive: 60,
        cleanStart: true,
        connectTimeout: 1000,
        autoReconnect: false,
        lwt: {
          topic: 'w',
          payload: 'x',
          qos: 0,
          retain: false,
          properties: { userProperties: { token: 'PLAIN-lwt', site: 'kept' } },
        },
        connectProperties: { userProperties: { password: 'PLAIN-connect' } },
      },
      publish: { topic: 't', payload: '', qos: 0, retain: false },
      subscribe: { topicFilter: '#', qos: 0 },
      templates: [],
    } as unknown as MqttRequest;
    const source = {
      id: 'c',
      name: 'c',
      items: [
        { id: 'k', name: 'k', type: 'request', request: kafka },
        { id: 'm', name: 'm', type: 'request', request: mqtt },
      ],
    } as unknown as Collection;
    const imported = ocToInternal(internalToOC(source));
    const redacted = redactCollectionSecrets(imported);
    expect(JSON.stringify(redacted)).not.toContain('PLAIN');
    expect(JSON.stringify(internalToOC(redacted))).not.toContain('PLAIN');
    expect(countCollectionInlineSecrets(redacted)).toBe(0);
  });
});

describe('console export URLs', () => {
  it.each([
    ['{{scheme}}://u:PLAIN@host/p'],
    ['//u:PLAIN@host/p'],
    ['user:PLAIN@host:50051'],
    ['https://u:pa/PLAIN@host'],
    ['{{base}}/x?api_key=PLAIN'],
  ])('%s holds no credential', (url) => {
    expect(sanitizeConsoleUrl(url)).not.toContain('PLAIN');
  });

  it('a parsed URL keeps its existing form, and ordinary values are unchanged', () => {
    expect(sanitizeConsoleUrl('https://u:PLAIN@host/p')).not.toContain('PLAIN');
    expect(sanitizeConsoleUrl('{{base}}/users/a@b')).toBe('{{base}}/users/a@b');
    expect(sanitizeConsoleUrl('https://host/a@b')).toBe('https://host/a@b');
  });

  it.each([
    ['https://h.test#access_token=PLAIN'],
    ['https://h.test?auth[password]=PLAIN'],
    ['https://h.test?next=https://u:PLAIN@o.test'],
    [' https://u:PLAIN@h.test'],
    ['https:\t//u:PLAIN@h.test'],
    ['https:u:PLAIN@h.test'],
    ['sip://u:PLAIN@h.test'],
  ])('%s holds no credential in a HAR file', (url) => {
    const entry = {
      id: 'e',
      timestamp: 1_700_000_000_000,
      protocol: 'http',
      request: { method: 'GET', url, headers: {} },
      response: {
        id: 'r',
        requestId: 'q',
        status: 302,
        statusText: 'Found',
        headers: {
          Location: 'https://u:PLAIN@a.test/x?token=PLAIN',
          'Content-Location': '//u:PLAIN@b.test',
          'x-other': 'kept-header',
        },
        body: '',
        size: 0,
        time: 1,
        timestamp: 1_700_000_000_001,
      },
    } as unknown as ConsoleEntry;
    const har = JSON.stringify(entriesToHar([entry]));
    expect(har).not.toContain('PLAIN');
    expect(har).toContain('kept-header');
  });

  it('stays fast on long unparsable input', () => {
    for (const input of ['?'.repeat(100_000), `${'?a=b&'.repeat(20_000)}`, '&'.repeat(100_000)]) {
      const start = performance.now();
      sanitizeConsoleUrl(input);
      expect(performance.now() - start).toBeLessThan(1_000);
    }
  });

  it('a HAR file holds no credential from an unparsable URL', () => {
    const entry = {
      id: 'e',
      timestamp: 1_700_000_000_000,
      protocol: 'http',
      request: { method: 'GET', url: '{{scheme}}://u:PLAIN@host/p', headers: {} },
      resolvedUrl: 'user:PLAIN@host:8080/p',
      response: {
        id: 'r',
        requestId: 'q',
        status: 200,
        statusText: 'OK',
        headers: {},
        body: '',
        size: 0,
        time: 1,
        timestamp: 1_700_000_000_001,
      },
    } as unknown as ConsoleEntry;
    expect(JSON.stringify(entriesToHar([entry]))).not.toContain('PLAIN');
  });
});
