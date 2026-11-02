// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countUrlStringSecrets,
  redactTextValueCredentials,
  redactUrlCredentialsForStorage,
  redactVariableValue,
} from '@shared/collections/postman/text-redaction';
import { internalToOC } from '@shared/opencollection/from-internal';
import { saveCollectionToDir } from '@shared/opencollection/node/fs-writer';
import { hasUrlUserinfo, stripUrlUserinfo } from '@shared/secrets/broker-preset-redaction';
import {
  countCollectionInlineSecrets,
  redactCollectionSecrets,
} from '@shared/secrets/collection-redaction';
import { isSecretFieldName } from '@shared/secrets/key-value-redaction';
import {
  redactUrlCredentialsForStorage as mcpRedactUrl,
  redactMcpCredentials,
} from '@shared/secrets/mcp-credential-redaction';
import { countRequestSecrets } from '@shared/secrets/request-secret-slots';
import type { Collection, CollectionItem, CollectionRequest, McpRequest } from '@shared/types';
import { describe, expect, it } from 'vitest';

/**
 * Export redaction applies one URL and address policy to every saved request
 * kind. Every string containing PLAIN is a fake credential.
 */

const itemWith = (id: string, request: Record<string, unknown>) =>
  ({ id, name: id, type: 'request', request }) as unknown as CollectionItem;

const collectionWith = (...requests: Array<Record<string, unknown>>): Collection => ({
  id: 'c',
  name: 'c',
  items: requests.map((request, i) => itemWith(`i${i}`, request)),
});

const REQUEST_KINDS: Array<[string, Record<string, unknown>]> = [
  ['http', { type: 'http', method: 'GET', headers: [], params: [] }],
  ['graphql', { type: 'http', method: 'POST', body: { type: 'graphql', raw: 'query { a }' } }],
  ['grpc', { type: 'grpc', metadata: [] }],
  ['sse', { type: 'sse', headers: [] }],
  ['mcp', { type: 'mcp', transport: 'streamable-http', headers: [] }],
  ['websocket', { type: 'websocket', headers: [] }],
  ['socketio', { type: 'socketio', handshakeAuth: [], query: [], headers: [] }],
];

describe('saved request URLs', () => {
  it.each(REQUEST_KINDS)('%s: blanks userinfo and credential query values', (_name, fields) => {
    const collection = collectionWith({
      id: 'r',
      name: 'r',
      ...fields,
      url: 'https://u:PLAIN-pw@api.test/p?access_token=PLAIN-token&page=1',
    });
    expect(countCollectionInlineSecrets(collection)).toBe(2);
    const redacted = redactCollectionSecrets(collection);
    expect(JSON.stringify(redacted)).not.toContain('PLAIN');
    expect(redacted.items[0]?.request).toMatchObject({
      url: 'https://api.test/p?access_token=&page=1',
    });
    expect(countCollectionInlineSecrets(redacted)).toBe(0);
  });

  it.each(REQUEST_KINDS)('%s: references and templated URLs survive', (_name, fields) => {
    for (const url of [
      'https://{{user}}:{{password}}@api.test/p',
      '{{base}}/p?access_token={{token}}&page=1',
      'https://{{host}}/p?token={{ token }}',
    ]) {
      const collection = collectionWith({ id: 'r', name: 'r', ...fields, url });
      expect(countCollectionInlineSecrets(collection)).toBe(0);
      expect(redactCollectionSecrets(collection).items[0]?.request).toMatchObject({ url });
    }
  });

  it('a literal mixed in with a reference is not a reference', () => {
    for (const [url, expected] of [
      ['https://{{user}}:PLAIN@api.test/p', 'https://api.test/p'],
      ['https://{{user}}@PLAIN@api.test/p', 'https://api.test/p'],
      ['{{base}}/p?token=PLAIN', '{{base}}/p?token='],
    ] as const) {
      expect(redactUrlCredentialsForStorage(url)).toBe(expected);
      expect(countUrlStringSecrets(url)).toBe(1);
      expect(countUrlStringSecrets(expected)).toBe(0);
    }
  });

  it('counts the URL once for a request with no passthrough copy', () => {
    const request = {
      id: 'r',
      name: 'r',
      type: 'mcp',
      headers: [],
      url: 'https://u:PLAIN@mcp.test/mcp',
    };
    expect(countRequestSecrets(request as unknown as CollectionRequest)).toBe(1);
    expect(countCollectionInlineSecrets(collectionWith(request))).toBe(1);
  });

  it('browser persistence and export use one URL policy', () => {
    expect(mcpRedactUrl).toBe(redactUrlCredentialsForStorage);
    const persisted = redactMcpCredentials({
      id: 'r',
      name: 'r',
      type: 'mcp',
      transport: 'streamable-http',
      headers: [],
      url: 'https://{{u}}:{{p}}@mcp.test/mcp?token=PLAIN',
    } as unknown as McpRequest);
    expect(persisted.url).toBe('https://{{u}}:{{p}}@mcp.test/mcp?token=');
    expect(countRequestSecrets(persisted)).toBe(0);
  });

  it('a non-string URL fails the count closed instead of reporting nothing', () => {
    const c = collectionWith({ id: 'r', name: 'r', type: 'http', url: { raw: 'x' } });
    expect(() => countCollectionInlineSecrets(c)).toThrow(TypeError);
    const absent = collectionWith({ id: 'r', name: 'r', type: 'http' });
    expect(countCollectionInlineSecrets(absent)).toBe(0);
  });
});

/** Forms the URL rule cannot separate from an ordinary value. */
const AMBIGUOUS_FORMS = [
  'https://u:123/ss@host',
  'https://u:/ss@host',
  '{{hunter2}}@host',
  'user:pa/ss@host:50051',
];

describe('URL userinfo forms', () => {
  it.each([
    ['user:PLAIN@host:50051', 'host:50051'],
    ['user:PLAIN@tail@host:50051/svc.Method', 'host:50051/svc.Method'],
    ['user:pa ss@host:50051', 'host:50051'],
    ['tok-PLAIN@host:50051', 'host:50051'],
    ['//u:PLAIN@host/p', '//host/p'],
    ['{{scheme}}://u:PLAIN@host/p', '{{scheme}}://host/p'],
    ['{{ scheme }}://u:PLAIN@tail@host', '{{ scheme }}://host'],
    ['https://u:pa/PLAIN@host', 'https://host'],
    ['https://u:pa/PLAIN@host/p?page=1', 'https://host/p?page=1'],
    ['{{scheme}}://u:pa/PLAIN@host', '{{scheme}}://host'],
    ['//u:pa/PLAIN@host', '//host'],
    ['https://u:PLAIN@h:zz/y@z', 'https://z'],
    ['https:///u:PLAIN@host', 'https:///host'],
    ['https:////u:PLAIN@host/p', 'https:////host/p'],
    ['https:/u:PLAIN@host', 'https:/host'],
    ['wss:///u:PLAIN@host', 'wss:///host'],
    ['{{scheme}}:///u:PLAIN@host', '{{scheme}}:///host'],
    ['https://u:pa?PLAIN@host', 'https://host'],
    ['https://u:pa#PLAIN@host', 'https://host'],
    ['https://u:pa/PLAIN@h?email=a@b', 'https://h?email=a@b'],
    ['{{a/b}}:PLAIN@host', 'host'],
    ['foo@bar/baz', 'bar/baz'],
    ['sip://u:PLAIN@host', 'sip://host'],
    ['data://u:PLAIN@host', 'data://host'],
    ['xmpp://u:PLAIN@host', 'xmpp://host'],
    [' https://u:PLAIN@h', 'https://h'],
    ['https://u:PLAIN@h \n', 'https://h'],
    ['https:\t//u:PLAIN@h', 'https://h'],
    ['ht\ntps://u:PLAIN@h', 'https://h'],
    ['https:u:PLAIN@h', 'https:h'],
    ['https://h#access_token=PLAIN&a=1', 'https://h#access_token=&a=1'],
    ['https://h/#/route?token=PLAIN', 'https://h/#/route?token='],
    ['https://h?auth[password]=PLAIN&user[name]=x', 'https://h?auth[password]=&user[name]=x'],
    ['https://h?a%5Bsecret%5D=PLAIN', 'https://h?a%5Bsecret%5D='],
    ['https://h?next=https://u:PLAIN@o/p&a=1', 'https://h?next=https://o/p&a=1'],
    [
      'https://h?next=https%3A%2F%2Fu%3APLAIN%40o%2Fp',
      `https://h?next=${encodeURIComponent('https://o/p')}`,
    ],
    ['https://h?next=https://o/p?token=PLAIN', 'https://h?next=https://o/p?token='],
    ['git@github.com:x', 'github.com:x'],
  ])('%s becomes %s, one edit, nothing left', (url, expected) => {
    expect(redactUrlCredentialsForStorage(url)).toBe(expected);
    expect(countUrlStringSecrets(url)).toBe(1);
    expect(redactUrlCredentialsForStorage(expected)).toBe(expected);
    expect(countUrlStringSecrets(expected)).toBe(0);
  });

  it('counts a query value as well as the userinfo', () => {
    expect(redactUrlCredentialsForStorage('user:PLAIN@host:50051?token=PLAIN&a=1')).toBe(
      'host:50051?token=&a=1'
    );
    expect(countUrlStringSecrets('user:PLAIN@host:50051?token=PLAIN&a=1')).toBe(2);
  });

  it.each([
    '{{base}}/users/a@b',
    'https://host/a@b',
    'https://host:8443/a@b',
    'https://host/p?email=a@b',
    'https://host#a@b',
    'https://[::1]:8443/a@b',
    'host:50051/svc.Method',
    'host:50051/users/a@b',
    'host/users/a@b',
    '{{host}}/x',
    '{{host}}:{{port}}/users/a@b',
    '{{host}}:8080/users/a@b',
    'https://{{host}}:{{port}}/a@b',
    '{{user}}:{{pw}}@host',
    '{{scheme}}://{{user}}:{{pw}}@host',
    '//{{user}}@host',
    '{{a:b}}/x@y',
    'file:///Users/a@b/x',
    'mailto:someone@example.test',
    'https://host:/a@b',
    'file:/C:/a@b',
    'sip:a@x',
    '{{host}}:v1/a@b',
    'file:///a@b/x',
    'file:///x:y/a@b',
    '{{a@b}}/x',
    ' https://h/p ',
    'https://h#section',
    'https://h#a=1&b=2',
    'https://h?next=https://o/p&a=1',
    'https://h?auth[type]=x',
    ...AMBIGUOUS_FORMS,
    'host?email=a@b',
    '',
  ])('%s is unchanged and not counted', (url) => {
    expect(redactUrlCredentialsForStorage(url)).toBe(url);
    expect(countUrlStringSecrets(url)).toBe(0);
  });

  it('reads a nested URL one level only', () => {
    const nested = 'https://h?next=https://o?next=https://u:v@x';
    expect(redactUrlCredentialsForStorage(nested)).toBe(nested);
  });

  it('counts a fragment parameter and a nested URL as one edit each', () => {
    expect(countUrlStringSecrets('https://u:p@h?next=https://u:p@o#token=x')).toBe(3);
  });

  it('stays linear and bounded on long input', () => {
    const SIZE = 200_000;
    for (const input of [
      `https://${'a@/'.repeat(10_000)}`,
      `https://${'a@/'.repeat(SIZE / 3)}`,
      `${' '.repeat(SIZE)}x`,
      `x${' '.repeat(SIZE)}x`,
      '?'.repeat(SIZE),
      '#'.repeat(SIZE),
      `h?${'a=b&'.repeat(SIZE / 4)}`,
      `h#${'token=b&'.repeat(SIZE / 8)}`,
      `h?${'a[b'.repeat(SIZE / 3)}=c`,
      `h?${'[]'.repeat(SIZE / 2)}=c`,
      'a@'.repeat(SIZE / 2),
      'a@//'.repeat(SIZE / 4),
      'a@b://'.repeat(SIZE / 6),
      'a:'.repeat(SIZE / 2),
      `${'a:'.repeat(SIZE / 2)}/x@y`,
      `{{${'a'.repeat(SIZE)}://u@h`,
      `${'{{'.repeat(SIZE / 2)}://u@h`,
      `${'{{a}}'.repeat(SIZE / 5)}:x/y@h`,
      `[${':'.repeat(SIZE)}/a@b`,
      `https://u:p/${'@'.repeat(SIZE)}`,
    ]) {
      const start = performance.now();
      const once = redactUrlCredentialsForStorage(input);
      countUrlStringSecrets(input);
      expect(performance.now() - start).toBeLessThan(1_000);
      expect(redactUrlCredentialsForStorage(once)).toBe(once);
    }
  });
});

describe('directory saves', () => {
  it('write inline URL credentials to no file and keep references', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'export-url-'));
    const http = {
      name: 'r',
      type: 'http',
      method: 'GET',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    };
    try {
      const collection = collectionWith(
        {
          ...http,
          id: 'p',
          name: 'literal',
          url: 'https://u:PLAIN-pw@api.test/p?access_token=PLAIN-token&region={{region}}',
        },
        {
          ...http,
          id: 'q',
          name: 'reference',
          url: 'https://{{user}}:{{pw}}@api.test/q?token={{token}}',
        }
      );

      // The same steps as the desktop directory save.
      await saveCollectionToDir(internalToOC(redactCollectionSecrets(collection)), dir);

      const names = await readdir(dir, { recursive: true });
      const files = await Promise.all(
        names.filter((n) => /\.ya?ml$/.test(n)).map((n) => readFile(join(dir, n), 'utf8'))
      );
      const onDisk = files.join('\n');
      expect(onDisk).not.toContain('PLAIN');
      expect(onDisk).toContain('https://api.test/p?access_token=&region={{region}}');
      expect(onDisk).toContain('https://{{user}}:{{pw}}@api.test/q?token={{token}}');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('broker and registry addresses', () => {
  it.each([
    ['mqtt://user:PLAIN@tail@broker.test:1883', 'mqtt://broker.test:1883'],
    ['mqtt://user:PLAIN tail@broker.test:1883', 'mqtt://broker.test:1883'],
    ['user:PLAIN@tail@b1:9092', 'b1:9092'],
    ['user:PLAIN tail@b1:9092', 'b1:9092'],
    ['{{user}}@PLAIN@b1:9092', 'b1:9092'],
    ['{{user}}:PLAIN@b1:9092', 'b1:9092'],
    ['https://user:PLAIN@tail@registry.test/x', 'https://registry.test/x'],
    ['mqtt://u:PLAIN@host/a@b', 'mqtt://host/a@b'],
  ])('%s has its userinfo removed', (address, expected) => {
    expect(hasUrlUserinfo(address)).toBe(true);
    expect(stripUrlUserinfo(address)).toBe(expected);
    expect(hasUrlUserinfo(expected)).toBe(false);
    expect(stripUrlUserinfo(expected)).toBe(expected);
  });

  it.each([
    'mqtt://user:PLAIN/ss@host:1883',
    'mqtt://user:PLAIN#ss@host:1883',
    'mqtt://user:PLAIN?ss@host:1883',
    'mqtt://user:123/PLAIN@host:1883',
    'mqtt://user:/PLAIN@host:1883',
    'mqtt://u:p@host:12/PLAIN@host',
    'mqtt:///user:PLAIN@host:1883',
    'https:///user:PLAIN@registry.test',
    'user:PLAIN/ss@b1:9092',
    'user:PLAIN#ss@b1:9092',
    '{{scheme}}://user:PLAIN@host:1883',
    ' mqtt://user:PLAIN@host:1883',
    'not a url/PLAIN@host',
  ])('%s has no safe parse and is blanked whole', (address) => {
    expect(hasUrlUserinfo(address)).toBe(true);
    expect(stripUrlUserinfo(address)).toBe('');
    expect(hasUrlUserinfo('')).toBe(false);
  });

  it.each([
    'mqtt://host/a@b',
    'mqtt://host#a@b',
    'mqtt://host?a=b@c',
    'mqtt://[::1]/a@b',
    'mqtt://host:1883',
    'mqtt://host:1883/mqtt',
    'b1:9092',
    '[::1]:9092',
    '{{broker}}',
    '{{u}}:{{p}}@b3:9092',
    'mqtt://{{u}}:{{p}}@host:1883',
    'mqtt://{{ u }}:{{ p }}@host:1883/a',
    'https://{{user}}@registry.test',
  ])('%s holds no credential and is unchanged', (address) => {
    expect(hasUrlUserinfo(address)).toBe(false);
    expect(stripUrlUserinfo(address)).toBe(address);
  });

  // Deliberate trade-off: each of these is valid without a credential, but has the
  // same shape as a password holding `/`, `?` or `#`. Addresses favour losing the
  // field, with the warning, over keeping part of a password.
  it.each([
    'mqtt://host:1883/a@b',
    'https://reg:8081/x?email=a@b',
    'https://reg:8081/x#a@b',
    '{{host}}/a@b',
    'https://{{host}}/a@b',
    'mqtt://{{host}}/a@b',
    'host:9092/a@b',
  ])('%s is blanked and counted although it may hold no credential', (address) => {
    expect(hasUrlUserinfo(address)).toBe(true);
    expect(stripUrlUserinfo(address)).toBe('');
  });

  it('blanks a credential query value and counts the address once', () => {
    expect(stripUrlUserinfo('mqtt://h:1883?token=PLAIN&a=1')).toBe('mqtt://h:1883?token=&a=1');
    expect(hasUrlUserinfo('mqtt://h:1883?token=PLAIN')).toBe(true);
    expect(hasUrlUserinfo('mqtt://h:1883?token=')).toBe(false);
  });

  it('gives the same answer on repeated calls', () => {
    for (let i = 0; i < 4; i++) {
      expect(hasUrlUserinfo('mqtt://u:p@h')).toBe(true);
      expect(stripUrlUserinfo('mqtt://u:p@h')).toBe('mqtt://h');
    }
  });

  it('stays linear on long input', () => {
    const SIZE = 200_000;
    for (const input of [
      'a'.repeat(SIZE),
      '@'.repeat(SIZE),
      `mqtt://${'@'.repeat(SIZE)}`,
      `${'a:'.repeat(SIZE / 2)}/x@y`,
      `${'{{'.repeat(SIZE / 2)}@h`,
      `${'{{a}}'.repeat(SIZE / 5)}@h`,
      `{{${' '.repeat(SIZE)}@h`,
      `mqtt://[${':'.repeat(SIZE)}/a@b`,
    ]) {
      const start = performance.now();
      hasUrlUserinfo(input);
      stripUrlUserinfo(input);
      expect(performance.now() - start).toBeLessThan(1_000);
    }
  });
});

describe('value scope and naming', () => {
  it.each([
    'C:\\proj\\node_modules\\@scope\\pkg',
    'nginx:1.25@sha256:x',
    '12:30@UTC',
    '{"url":"https://x/y?token=abc","other":"v"}',
    'line one https://u:p@h\nline two',
    'https://u:p@h\nsecond line',
    'https://u:p@h and text',
    '"https://u:p@h"',
    "'https://u:p@h'",
    'user:p@db:5432',
    '//u:p@h',
    'https:u:p@h',
    '{{base}}/x?api_key=T',
    'someone@example.test',
  ])('free-form value %j is unchanged', (value) => {
    expect(redactTextValueCredentials(value)).toBe(value);
    expect(redactVariableValue('NOTE', value)).toBe(value);
  });

  it.each([
    ['https://u:p@h/x', 'https://h/x'],
    [' https://u:p@h/x ', 'https://h/x'],
    ['{{scheme}}://u:p@h', '{{scheme}}://h'],
    ['jdbc:mysql://u:p@h/db', 'jdbc:mysql://h/db'],
    ['https://h/x?token=abc', 'https://h/x?token='],
  ])('whole-URL value %j is redacted', (value, expected) => {
    expect(redactTextValueCredentials(value)).toBe(expected);
  });

  it('a credential-named free-form value is blanked whatever its shape', () => {
    expect(redactVariableValue('API_TOKEN', 'nginx:1.25@sha256:x')).toBe('');
  });

  it('a request URL field keeps the full address rule', () => {
    expect(redactUrlCredentialsForStorage('user:p@db:5432')).toBe('db:5432');
    expect(redactUrlCredentialsForStorage('//u:p@h')).toBe('//h');
  });

  it.each([
    ['jdbc:mysql://u:PLAIN@h/db', 'jdbc:mysql://h/db'],
    ['view-source:https://u:PLAIN@h/', 'view-source:https://h/'],
    ['ssh://git:PLAIN@github.com/org/repo.git', 'ssh://github.com/org/repo.git'],
    ['git://git:PLAIN@github.com/r', 'git://github.com/r'],
  ])('scheme form %s becomes %s with one edit', (url, expected) => {
    expect(redactUrlCredentialsForStorage(url)).toBe(expected);
    expect(countUrlStringSecrets(url)).toBe(1);
    expect(countUrlStringSecrets(expected)).toBe(0);
  });

  it.each([
    'ssh://git@github.com/org/repo.git',
    'git://git@github.com/r',
    'git+ssh://git@github.com/r',
  ])('account-name form %s is unchanged', (url) => {
    expect(redactUrlCredentialsForStorage(url)).toBe(url);
    expect(countUrlStringSecrets(url)).toBe(0);
  });

  it.each([
    'https://h?authSource=admin&authMechanism=SCRAM',
    'https://h?token_type=bearer',
    'https://h?filter[key]=a&sort[key]=b&page[token]=c',
  ])('query %s is unchanged', (url) => {
    expect(redactUrlCredentialsForStorage(url)).toBe(url);
  });

  it.each(['auth[password]', 'auth[token]', 'auth[key]', 'user[secret]', 'a[auth][key]'])(
    '%s is a credential name',
    (name) => {
      expect(isSecretFieldName(name)).toBe(true);
    }
  );

  it.each(['filter[key]', 'sort[key]', 'page[token]', 'authSource', 'authMechanism', 'token_type'])(
    '%s is not a credential name',
    (name) => {
      expect(isSecretFieldName(name)).toBe(false);
    }
  );

  it('stays bounded on a long bracketed name', () => {
    const start = performance.now();
    expect(isSecretFieldName(`a${'[key]'.repeat(50_000)}`)).toBe(false);
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it.each(['{{my key}}', '{{a}}:{{b}}', '{{a}}{{b}}', ' {{ a }} ', '{{a:b}}'])(
    'reference value %j is kept under a credential name',
    (value) => {
      expect(redactVariableValue('API_TOKEN', value)).toBe(value);
      const url = `https://h?token=${value.trim()}`;
      expect(redactUrlCredentialsForStorage(url)).toBe(url);
    }
  );

  it.each(['{{a}}:PLAIN', 'PLAIN{{a}}', '{{a}}PLAIN', '{{ }}', '{{}}', '{{a\nb}}', '{{a}}:{{b}}x'])(
    'mixed value %j is blanked under a credential name',
    (value) => {
      expect(redactVariableValue('API_TOKEN', value)).toBe('');
    }
  );

  it('reference userinfo follows the token grammar, and a literal does not pass', () => {
    const url = 'https://{{my user}}:{{my pass}}@h';
    expect(redactUrlCredentialsForStorage(url)).toBe(url);
    expect(redactUrlCredentialsForStorage('https://{{my user}}:PLAIN@h')).toBe('https://h');
  });

  it('a nested value that cannot be encoded is blanked without throwing', () => {
    const url = 'https://h?next=https%3A%2F%2Fu%3Ap%40o\uD800&a=1';
    expect(redactUrlCredentialsForStorage(url)).toBe('https://h?next=&a=1');
    expect(countUrlStringSecrets(url)).toBe(1);
    expect(countUrlStringSecrets('https://h?next=&a=1')).toBe(0);
  });

  it('Postman sidecar variables follow the variable name rule', () => {
    const variable = [
      { key: 'TOKEN_URL', value: 'https://idp.test/t' },
      { key: 'public_key', value: 'kept-public' },
      { key: 'token_type', value: 'kept-type' },
      { key: 'API_TOKEN', value: 'PLAIN' },
    ];
    const c = collectionWith();
    c.items.push({
      id: 'f',
      name: 'f',
      type: 'folder',
      items: [],
      _postman: { variable },
    } as unknown as CollectionItem);
    expect(countCollectionInlineSecrets(c)).toBe(1);
    const text = JSON.stringify(redactCollectionSecrets(c));
    expect(text).not.toContain('PLAIN');
    for (const kept of ['https://idp.test/t', 'kept-public', 'kept-type']) {
      expect(text).toContain(kept);
    }
  });
});
