import { describe, expect, it } from 'vitest';
import type { Collection, CollectionItem } from '../../types';
import { countCollectionInlineSecrets, redactCollectionSecrets } from '../collection-redaction';

/**
 * Characterization of the export redaction walks, recorded against the code as
 * it stood BEFORE the one-slot-list refactor. These snapshots are the proof of
 * no behaviour change; a diff here means an export file or warning changed.
 * Do not update one to make a refactor pass.
 *
 * Every string containing PLAIN is a fake credential. `residual` is
 * `count(redact(c))`; `count` is the export warning number.
 */

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Runs both walks on a frozen fixture, so any mutation of the input throws. */
function record(collection: Collection) {
  deepFreeze(collection);
  const redacted = redactCollectionSecrets(collection);
  return {
    count: countCollectionInlineSecrets(collection),
    residual: countCollectionInlineSecrets(redacted),
    redacted,
  };
}

function row(key: string, value: string, extra: Record<string, unknown> = {}) {
  return { id: key, key, value, enabled: true, ...extra };
}

const NO_AUTH = { type: 'none' };
const BEARER = { type: 'bearer', bearer: { token: 'PLAIN-bearer' } };

function requestItem(request: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: 'item',
    name: 'item',
    type: 'request',
    request,
    ...extra,
  } as unknown as CollectionItem;
}

function collectionOf(items: CollectionItem[], extra: Record<string, unknown> = {}): Collection {
  return { id: 'c', name: 'c', items, ...extra } as Collection;
}

const FIXTURES = {
  http: collectionOf([
    requestItem({
      id: 'r',
      name: 'http',
      type: 'http',
      method: 'POST',
      url: 'https://user:PLAIN-url-pw@api.test/v1?api_key=PLAIN-url-key&page=1',
      headers: [
        row('Authorization', 'PLAIN-header'),
        row('Accept', 'application/json'),
        row('X-Flagged', 'PLAIN-flagged', { secret: true }),
        row('X-Api-Key', ''),
      ],
      params: [row('api_key', 'PLAIN-param'), row('page_token', 'cursor-kept')],
      body: {
        type: 'x-www-form-urlencoded',
        formData: [
          row('client_secret', 'PLAIN-form'),
          row('grant_type', 'client_credentials'),
          row('password', 'PLAIN-file-row-untouched', { type: 'file' }),
        ],
      },
      auth: BEARER,
    }),
  ]),
  httpFormData: collectionOf([
    requestItem({
      id: 'r',
      name: 'form-data',
      type: 'http',
      method: 'POST',
      url: 'https://api.test',
      headers: [],
      params: [],
      body: {
        type: 'form-data',
        formData: [
          row('password', 'PLAIN-form-data', { type: 'text' }),
          row('upload', 'file.bin', { type: 'file' }),
        ],
      },
      auth: NO_AUTH,
    }),
  ]),
  httpLeftoverFormRows: collectionOf([
    requestItem({
      id: 'r',
      name: 'json body with stale form rows',
      type: 'http',
      method: 'POST',
      url: 'https://api.test',
      headers: [],
      params: [],
      body: {
        type: 'json',
        raw: '{"api_key":"PLAIN-free-form-body"}',
        formData: [row('password', 'PLAIN-unsent-row')],
      },
      auth: NO_AUTH,
    }),
  ]),
  graphql: collectionOf([
    requestItem({
      id: 'r',
      name: 'graphql',
      type: 'http',
      method: 'POST',
      url: 'https://api.test/graphql',
      headers: [row('x-api-key', 'PLAIN-gql-header')],
      params: [],
      body: {
        type: 'graphql',
        raw: 'query { me { id } }',
        graphqlVariables: '{"token":"PLAIN-gql-variable"}',
      },
      auth: {
        type: 'apiKey',
        apiKey: { key: 'X-Key', value: 'PLAIN-gql-apikey', in: 'header' },
      },
    }),
  ]),
  grpc: collectionOf([
    requestItem({
      id: 'r',
      name: 'grpc',
      type: 'grpc',
      methodType: 'unary',
      url: 'grpc://api.test:50051',
      service: 'S',
      method: 'M',
      metadata: [row('authorization', 'PLAIN-metadata'), row('x-trace', 'kept')],
      message: '{}',
      auth: {
        type: 'basic',
        basic: { username: 'kept-user', password: 'PLAIN-basic' },
      },
    }),
  ]),
  websocket: collectionOf([
    requestItem({
      id: 'r',
      name: 'ws',
      type: 'websocket',
      url: 'wss://user:PLAIN-ws-pw@ws.test/socket?access_token=PLAIN-ws-token&room={{room}}',
      protocols: ['chat'],
      headers: [row('Cookie', 'PLAIN-ws-cookie'), row('X-Client', 'kept')],
      message: { body: '{"token":"PLAIN-ws-draft"}', format: 'json' },
      templates: [{ name: 't', body: 'PLAIN-ws-template', format: 'text' }],
    }),
  ]),
  socketioRows: collectionOf([
    requestItem({
      id: 'r',
      name: 'sio rows',
      type: 'socketio',
      url: 'https://user:PLAIN-sio-pw@sio.test?token=PLAIN-sio-url',
      namespace: '/',
      path: '/socket.io',
      handshakeAuth: [row('anything', 'PLAIN-handshake'), row('ref', '{{tokenVar}}'), row('e', '')],
      query: [row('api_key', 'PLAIN-sio-query'), row('room', 'kept')],
      headers: [row('Authorization', 'PLAIN-sio-header')],
      transports: ['websocket'],
      subscribedEvents: [],
      emit: { eventName: 'e', args: '[]', ack: false },
      templates: [],
    }),
  ]),
  socketioJson: collectionOf([
    requestItem({
      id: 'r',
      name: 'sio json',
      type: 'socketio',
      url: 'https://sio.test',
      namespace: '/',
      path: '/socket.io',
      handshakeAuth: [],
      handshakeAuthMode: 'json',
      handshakeAuthJson: '{"token":"PLAIN-json","nested":{"n":1,"ref":"{{v}}"},"bare":{{bare}}}',
      query: [],
      headers: [],
      transports: ['polling'],
      subscribedEvents: [],
      emit: { eventName: 'e', args: '[]', ack: false },
      templates: [],
    }),
  ]),
  socketioUnparseableJson: collectionOf([
    requestItem({
      id: 'r',
      name: 'sio bad json',
      type: 'socketio',
      url: 'https://sio.test',
      namespace: '/',
      path: '/socket.io',
      handshakeAuth: [],
      handshakeAuthJson: '{not json PLAIN-unparseable',
      query: [],
      headers: [],
      transports: [],
      subscribedEvents: [],
      emit: { eventName: 'e', args: '[]', ack: false },
      templates: [],
    }),
  ]),
  sse: collectionOf([
    requestItem({
      id: 'r',
      name: 'sse',
      type: 'sse',
      url: 'https://sse.test/events?token=PLAIN-sse-url',
      headers: [row('Authorization', 'PLAIN-sse-header')],
      params: [row('secret', 'PLAIN-sse-param')],
      auth: BEARER,
    }),
  ]),
  mcpHttp: collectionOf([
    requestItem({
      id: 'r',
      name: 'mcp',
      type: 'mcp',
      url: 'https://user:PLAIN-mcp-pw@mcp.test/mcp',
      transport: 'streamable-http',
      headers: [row('X-MCP-Auth', 'PLAIN-mcp-header')],
      auth: {
        type: 'oauth2',
        oauth2: { accessToken: 'PLAIN-oauth', clientId: 'kept-client' },
      },
    }),
  ]),
  mcpStdio: collectionOf([
    requestItem({
      id: 'r',
      name: 'mcp stdio',
      type: 'mcp',
      url: '',
      transport: 'stdio',
      stdio: {
        command: 'npx',
        args: ['server', '--token', 'PLAIN-argv-not-walked'],
        env: [
          row('LOG_LEVEL', 'debug'),
          row('API_TOKEN', 'PLAIN-env-named'),
          row('CUSTOM', 'PLAIN-env-flagged', { secret: true }),
          row('INLINE_REF', '', {
            secretRef: { kind: 'inline', value: 'PLAIN-env-ref' },
          }),
          row('STRING_REF', '', { secretRef: 'PLAIN-env-string-ref' }),
          row('HANDLE_REF', '', {
            secretRef: { kind: 'handle', id: 'h-1', label: 'kept' },
          }),
        ],
      },
      headers: [],
      auth: NO_AUTH,
    }),
  ]),
  kafka: collectionOf([
    requestItem({
      id: 'r',
      name: 'kafka',
      type: 'kafka',
      connection: {
        bootstrapBrokers: ['alice:PLAIN-broker@b1:9092', 'b2:9092', '{{u}}:{{p}}@b3:9092'],
        clientId: 'c',
        securityProtocol: 'SASL_SSL',
        sasl: {
          mechanism: 'PLAIN',
          username: 'kept',
          extensions: { token: 'PLAIN-sasl-ext' },
        },
        registry: { url: 'https://reg:PLAIN-registry@registry.test' },
        acks: 1,
        compression: 'none',
        idempotent: false,
      },
      produce: {
        topic: 't',
        key: '',
        keyEncoding: 'utf8',
        value: 'PLAIN-payload-kept',
        valueEncoding: 'utf8',
        headers: [row('x-api-key', 'PLAIN-record-header'), row('trace', 'kept')],
      },
      consume: { groupId: 'g', topics: [], mode: 'committed' },
    }),
  ]),
  kafkaNoRegistry: collectionOf([
    requestItem({
      id: 'r',
      name: 'kafka bare',
      type: 'kafka',
      connection: {
        bootstrapBrokers: [],
        clientId: 'c',
        securityProtocol: 'PLAINTEXT',
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
      },
      consume: { groupId: 'g', topics: [], mode: 'committed' },
    }),
  ]),
  mqtt: collectionOf([
    requestItem({
      id: 'r',
      name: 'mqtt',
      type: 'mqtt',
      connection: {
        brokerUrl: 'mqtts://dev:PLAIN-mqtt@broker.test:8883',
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
          properties: { userProperties: { token: 'PLAIN-lwt-prop' } },
        },
        connectProperties: {
          userProperties: { password: 'PLAIN-connect-prop' },
        },
      },
      publish: {
        topic: 't',
        payload: 'kept',
        qos: 0,
        retain: false,
        userProperties: { authorization: 'PLAIN-publish-prop', trace: 'kept' },
      },
      subscribe: { topicFilter: '#', qos: 0 },
      templates: [
        {
          name: 'with props',
          topic: 't',
          payload: 'kept',
          qos: 0,
          retain: false,
          userProperties: {
            'x-api-key': 'PLAIN-template-prop',
            empty_token: '',
          },
        },
        {
          name: 'no props',
          topic: 't',
          payload: 'kept',
          qos: 0,
          retain: false,
        },
      ],
    }),
  ]),
  folderAuth: collectionOf([
    {
      id: 'f',
      name: 'folder',
      type: 'folder',
      auth: {
        type: 'digest',
        digest: { username: 'kept', password: 'PLAIN-folder-digest' },
      },
      variables: [row('folderSecret', 'PLAIN-folder-variable-kept', { secret: true })],
      items: [
        {
          id: 'f2',
          name: 'nested',
          type: 'folder',
          auth: {
            type: 'wsse',
            wsse: { username: 'kept', password: 'PLAIN-nested-wsse' },
          },
          items: [],
        },
      ],
    } as unknown as CollectionItem,
  ]),
  collectionAuth: collectionOf([], {
    auth: {
      type: 'aws-signature',
      awsSignature: {
        accessKey: 'kept-access',
        secretKey: 'PLAIN-aws',
        region: 'us-east-1',
      },
      oauth1: {
        consumerSecret: 'PLAIN-c',
        accessToken: 'PLAIN-a',
        accessTokenSecret: 'PLAIN-s',
      },
      ntlm: {
        username: 'kept',
        password: { kind: 'inline', value: 'PLAIN-ntlm-inline' },
      },
    },
    variables: [row('rootSecret', 'PLAIN-root-variable-kept', { secret: true })],
  }),
  handles: collectionOf(
    [
      requestItem({
        id: 'r',
        name: 'handles',
        type: 'http',
        method: 'GET',
        url: 'https://api.test',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: {
          type: 'bearer',
          bearer: { token: { kind: 'handle', id: 'h-req', label: 'req' } },
        },
      }),
    ],
    {
      auth: {
        type: 'basic',
        basic: { username: 'kept', password: { kind: 'handle', id: 'h-root' } },
      },
    }
  ),
  rootOc: collectionOf(
    [
      requestItem(
        {
          id: 'r',
          name: 'typed copy',
          type: 'http',
          method: 'GET',
          url: 'https://api.test',
          headers: [row('Authorization', 'PLAIN-typed-header')],
          params: [],
          body: { type: 'none' },
          auth: BEARER,
        },
        // Not counted while the root bag exists (that would double-count).
        {
          _oc: {
            auth: { type: 'hawk', password: 'PLAIN-item-bag-root-present' },
          },
        }
      ),
    ],
    {
      _oc: {
        info: { name: 'c' },
        config: {
          clientCertificates: [{ passphrase: 'PLAIN-cert-pass' }],
          proxy: {
            config: { auth: { username: 'kept', password: 'PLAIN-proxy' } },
          },
        },
        items: [
          {
            info: { type: 'http', name: 'typed copy' },
            http: {
              url: 'https://u:PLAIN-oc-url@api.test?api_key=PLAIN-oc-query',
              headers: [{ name: 'Authorization', value: 'PLAIN-oc-typed-header' }],
              auth: {
                type: 'oauth2',
                accessToken: 'PLAIN-oc-typed-flat',
                credentials: { clientSecret: 'PLAIN-oc-nested' },
                resourceOwner: { password: 'PLAIN-oc-owner' },
              },
            },
          },
          {
            info: { type: 'http', name: 'degrade' },
            http: {
              auth: {
                type: 'hawk',
                password: 'PLAIN-oc-degrade',
                hawkId: 'kept',
              },
            },
          },
          {
            info: { type: 'http', name: 'rsa' },
            http: {
              auth: {
                type: 'oauth1',
                consumerSecret: 'PLAIN-oc-oauth1',
                privateKey: { type: 'text', value: 'PLAIN-oc-rsa' },
              },
            },
          },
          {
            info: { type: 'http', name: 'rsa file' },
            http: {
              auth: {
                type: 'oauth1',
                privateKey: { type: 'file', value: '/kept/key.pem' },
              },
            },
          },
          {
            info: { type: 'socketio', name: 'opaque' },
            socketio: {
              url: 'https://sio.test',
              headers: [
                { name: 'X-Api-Key', value: 'PLAIN-opaque-header' },
                { name: 'X-Ref', value: '{{ref}}', secret: true },
                { name: 'accept', value: 'kept' },
              ],
              auth: { type: 'bearer', token: 'PLAIN-opaque-auth' },
            },
          },
          {
            info: { type: 'websocket', name: 'auth opaque' },
            auth: { type: 'bearer', token: 'PLAIN-ws-bag-auth' },
          },
        ],
        extensions: {
          'x-restura-mcp': [
            {
              info: { type: 'mcp', name: 'ext' },
              mcp: {
                url: 'https://mcp.test?token=PLAIN-ext-url',
                headers: [{ name: 'X-Auth', value: 'PLAIN-ext-header' }],
                auth: { type: 'bearer', token: 'PLAIN-ext-typed' },
                stdio: {
                  command: 'npx',
                  env: [
                    { name: 'API_KEY', value: 'PLAIN-ext-env' },
                    {
                      name: 'REF',
                      value: '',
                      secretRef: { kind: 'inline', value: 'PLAIN-ref' },
                    },
                    {
                      name: 'HANDLE',
                      value: '',
                      secretRef: { kind: 'handle', id: 'h-oc' },
                    },
                    { name: 'LOG', value: 'kept' },
                  ],
                },
              },
            },
          ],
        },
        environments: [
          {
            name: 'e',
            variables: [{ name: 'v', value: 'PLAIN-oc-secret-var', secret: true }],
          },
        ],
      },
    }
  ),
  perItemOc: collectionOf([
    requestItem(
      {
        id: 'r',
        name: 'bag only',
        type: 'http',
        method: 'GET',
        url: 'https://api.test',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: NO_AUTH,
      },
      {
        _oc: {
          info: { type: 'http' },
          http: {
            auth: {
              type: 'bearer',
              token: 'PLAIN-modelled-flat-not-counted',
              credentials: { clientSecret: 'PLAIN-modelled-nested-counted' },
            },
            headers: [
              {
                name: 'Authorization',
                value: 'PLAIN-modelled-row-not-counted',
              },
            ],
          },
        },
      }
    ),
    {
      id: 'placeholder',
      name: 'opaque placeholder',
      type: 'folder',
      items: [],
      _oc: {
        info: { type: 'graphql-subscription' },
        auth: { type: 'bearer', token: 'PLAIN-placeholder-token' },
        headers: [{ name: 'X-Api-Key', value: 'PLAIN-placeholder-row' }],
      },
    } as unknown as CollectionItem,
    {
      id: 'real-folder',
      name: 'real oc folder',
      type: 'folder',
      items: [],
      _oc: { auth: { type: 'bearer', token: 'PLAIN-folder-flat-not-counted' } },
    } as unknown as CollectionItem,
  ]),
  postman: collectionOf(
    [
      requestItem(
        {
          id: 'r',
          name: 'pm',
          type: 'http',
          method: 'GET',
          url: 'https://api.test',
          headers: [],
          params: [],
          body: { type: 'none' },
          auth: BEARER,
        },
        {
          _postman: {
            auth: {
              type: 'hawk',
              hawk: [
                { key: 'authId', value: 'kept' },
                { key: 'authKey', value: 'PLAIN-hawk' },
              ],
            },
            authBagOnly: true,
            variable: [{ key: 'token', value: 'PLAIN-pm-var' }],
            urlVariable: [{ key: 'k', value: 'PLAIN-pm-urlvar', type: 'secret' }],
            body: { formdata: [{ key: 'password', value: 'PLAIN-pm-form' }] },
            response: [
              {
                name: 'saved',
                header: [{ key: 'Set-Cookie', value: 'PLAIN-pm-resp-header' }],
                cookie: [{ name: 'sid', value: 'PLAIN-pm-cookie' }],
                body: 'PLAIN-pm-resp-body',
                originalRequest: {
                  header: 'Authorization: PLAIN-pm-line\nAccept: kept',
                  url: {
                    raw: 'https://u:PLAIN-pm-raw@api.test?token=PLAIN-pm-raw-q',
                    query: [{ key: 'token', value: 'PLAIN-pm-query' }],
                    auth: { password: 'PLAIN-pm-url-auth', user: 'kept' },
                  },
                  auth: {
                    type: 'bearer',
                    bearer: { token: 'PLAIN-pm-orig-auth' },
                  },
                  body: { mode: 'raw', raw: 'PLAIN-pm-orig-body' },
                },
              },
              {
                name: 'map headers',
                header: { Authorization: 'PLAIN-pm-map', Accept: 'kept' },
              },
            ],
            settings: { clientSecret: 'PLAIN-pm-v3-setting', timeout: 5 },
            scripts: [{ code: 'fetch("https://x.test?token=PLAIN-pm-script")' }],
            item: {
              $kind: 'mcp',
              command: 'run --key PLAIN-pm-command',
              argv: ['run', 'PLAIN-pm-argv'],
              env: [{ key: 'API_KEY', value: 'PLAIN-pm-env' }],
            },
          },
        }
      ),
      {
        id: 'pm-folder',
        name: 'pm folder',
        type: 'folder',
        items: [],
        _postman: {
          auth: {
            type: 'jwt',
            jwt: { secret: 'PLAIN-pm-folder-jwt', algorithm: 'HS256' },
          },
        },
      } as unknown as CollectionItem,
    ],
    {
      _postman: {
        auth: {
          type: 'oauth2',
          oauth2: {
            accessToken: 'PLAIN-pm-root-mapped-not-counted',
            tokenRequestParams: [
              {
                key: 'client_assertion',
                value: 'PLAIN-pm-row',
                send_as: 'body',
              },
            ],
          },
        },
        variable: [{ key: 'public', value: 'kept' }],
      },
    }
  ),
  bothBagsOnOneItem: collectionOf([
    requestItem(
      {
        id: 'r',
        name: 'both',
        type: 'http',
        method: 'GET',
        url: 'https://api.test',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: NO_AUTH,
      },
      {
        _oc: { http: { auth: { type: 'hawk', password: 'PLAIN-both-oc' } } },
        _postman: { variable: [{ key: 'token', value: 'PLAIN-both-pm' }] },
      }
    ),
  ]),
};

/** Fixtures where `count(redact(c)) !== 0` on the pre-refactor code. See the block below. */
const PINNED_VIOLATIONS = {
  // Broker userinfo stops at the FIRST `@`, so part of the password SURVIVES redaction.
  mqttAtSignInPassword: collectionOf([
    requestItem({
      id: 'r',
      name: 'mqtt @',
      type: 'mqtt',
      connection: { brokerUrl: 'mqtt://user:PLAIN@tail@broker.test:1883' },
      publish: { topic: 't', payload: '', qos: 0, retain: false },
      subscribe: { topicFilter: '#', qos: 0 },
      templates: [],
    }),
  ]),
  kafkaAtSignInPassword: collectionOf([
    requestItem({
      id: 'r',
      name: 'kafka @',
      type: 'kafka',
      connection: {
        bootstrapBrokers: ['user:PLAIN@tail@b1:9092'],
        registry: { url: 'https://user:PLAIN@tail@registry.test' },
      },
      produce: { headers: [] },
      consume: {},
    }),
  ]),
  // External refs are preserved by `redactSecret` but counted as inline.
  externalSecretRef: collectionOf([], {
    auth: {
      type: 'bearer',
      bearer: {
        token: {
          kind: 'external',
          provider: 'aws-secrets-manager',
          profileId: 'p',
          secretId: 'prod/token',
        },
      },
    },
  }),
};

/** A folder chain whose deepest item sits at `depth` (root items are depth 0). */
function chain(depth: number, leaf: Record<string, unknown>): Collection {
  let node = { id: `n${depth}`, name: `n${depth}`, type: 'folder', ...leaf };
  for (let d = depth - 1; d >= 0; d--) {
    node = {
      id: `n${d}`,
      name: `n${d}`,
      type: 'folder',
      items: [node],
    } as typeof node;
  }
  return collectionOf([node as unknown as CollectionItem]);
}

function itemAtDepth(collection: Collection, depth: number): CollectionItem {
  let node = collection.items[0] as CollectionItem;
  for (let d = 0; d < depth; d++) node = node.items?.[0] as CollectionItem;
  return node;
}

describe('collection redaction characterization', () => {
  it('http', () => {
    expect(record(FIXTURES.http)).toMatchInlineSnapshot(`
      {
        "count": 5,
        "redacted": {
          "id": "c",
          "items": [
            {
              "id": "item",
              "name": "item",
              "request": {
                "auth": {
                  "bearer": {
                    "token": "",
                  },
                  "type": "bearer",
                },
                "body": {
                  "formData": [
                    {
                      "enabled": true,
                      "id": "client_secret",
                      "key": "client_secret",
                      "value": "",
                    },
                    {
                      "enabled": true,
                      "id": "grant_type",
                      "key": "grant_type",
                      "value": "client_credentials",
                    },
                    {
                      "enabled": true,
                      "id": "password",
                      "key": "password",
                      "type": "file",
                      "value": "PLAIN-file-row-untouched",
                    },
                  ],
                  "type": "x-www-form-urlencoded",
                },
                "headers": [
                  {
                    "enabled": true,
                    "id": "Authorization",
                    "key": "Authorization",
                    "value": "",
                  },
                  {
                    "enabled": true,
                    "id": "Accept",
                    "key": "Accept",
                    "value": "application/json",
                  },
                  {
                    "enabled": true,
                    "id": "X-Flagged",
                    "key": "X-Flagged",
                    "secret": true,
                    "value": "",
                  },
                  {
                    "enabled": true,
                    "id": "X-Api-Key",
                    "key": "X-Api-Key",
                    "value": "",
                  },
                ],
                "id": "r",
                "method": "POST",
                "name": "http",
                "params": [
                  {
                    "enabled": true,
                    "id": "api_key",
                    "key": "api_key",
                    "value": "",
                  },
                  {
                    "enabled": true,
                    "id": "page_token",
                    "key": "page_token",
                    "value": "cursor-kept",
                  },
                ],
                "type": "http",
                "url": "https://user:PLAIN-url-pw@api.test/v1?api_key=PLAIN-url-key&page=1",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('http form-data', () => {
    expect(record(FIXTURES.httpFormData)).toMatchInlineSnapshot(`
      {
        "count": 1,
        "redacted": {
          "id": "c",
          "items": [
            {
              "id": "item",
              "name": "item",
              "request": {
                "auth": {
                  "type": "none",
                },
                "body": {
                  "formData": [
                    {
                      "enabled": true,
                      "id": "password",
                      "key": "password",
                      "type": "text",
                      "value": "",
                    },
                    {
                      "enabled": true,
                      "id": "upload",
                      "key": "upload",
                      "type": "file",
                      "value": "file.bin",
                    },
                  ],
                  "type": "form-data",
                },
                "headers": [],
                "id": "r",
                "method": "POST",
                "name": "form-data",
                "params": [],
                "type": "http",
                "url": "https://api.test",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('http with form rows left over on a non-form body', () => {
    expect(record(FIXTURES.httpLeftoverFormRows)).toMatchInlineSnapshot(`
      {
        "count": 0,
        "redacted": {
          "id": "c",
          "items": [
            {
              "id": "item",
              "name": "item",
              "request": {
                "auth": {
                  "type": "none",
                },
                "body": {
                  "formData": [
                    {
                      "enabled": true,
                      "id": "password",
                      "key": "password",
                      "value": "PLAIN-unsent-row",
                    },
                  ],
                  "raw": "{"api_key":"PLAIN-free-form-body"}",
                  "type": "json",
                },
                "headers": [],
                "id": "r",
                "method": "POST",
                "name": "json body with stale form rows",
                "params": [],
                "type": "http",
                "url": "https://api.test",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('graphql', () => {
    expect(record(FIXTURES.graphql)).toMatchInlineSnapshot(`
      {
        "count": 2,
        "redacted": {
          "id": "c",
          "items": [
            {
              "id": "item",
              "name": "item",
              "request": {
                "auth": {
                  "apiKey": {
                    "in": "header",
                    "key": "X-Key",
                    "value": "",
                  },
                  "type": "apiKey",
                },
                "body": {
                  "graphqlVariables": "{"token":"PLAIN-gql-variable"}",
                  "raw": "query { me { id } }",
                  "type": "graphql",
                },
                "headers": [
                  {
                    "enabled": true,
                    "id": "x-api-key",
                    "key": "x-api-key",
                    "value": "",
                  },
                ],
                "id": "r",
                "method": "POST",
                "name": "graphql",
                "params": [],
                "type": "http",
                "url": "https://api.test/graphql",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('grpc', () => {
    expect(record(FIXTURES.grpc)).toMatchInlineSnapshot(`
      {
        "count": 2,
        "redacted": {
          "id": "c",
          "items": [
            {
              "id": "item",
              "name": "item",
              "request": {
                "auth": {
                  "basic": {
                    "password": "",
                    "username": "kept-user",
                  },
                  "type": "basic",
                },
                "id": "r",
                "message": "{}",
                "metadata": [
                  {
                    "enabled": true,
                    "id": "authorization",
                    "key": "authorization",
                    "value": "",
                  },
                  {
                    "enabled": true,
                    "id": "x-trace",
                    "key": "x-trace",
                    "value": "kept",
                  },
                ],
                "method": "M",
                "methodType": "unary",
                "name": "grpc",
                "service": "S",
                "type": "grpc",
                "url": "grpc://api.test:50051",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('websocket', () => {
    expect(record(FIXTURES.websocket)).toMatchInlineSnapshot(`
      {
        "count": 3,
        "redacted": {
          "id": "c",
          "items": [
            {
              "id": "item",
              "name": "item",
              "request": {
                "headers": [
                  {
                    "enabled": true,
                    "id": "Cookie",
                    "key": "Cookie",
                    "value": "",
                  },
                  {
                    "enabled": true,
                    "id": "X-Client",
                    "key": "X-Client",
                    "value": "kept",
                  },
                ],
                "id": "r",
                "message": {
                  "body": "{"token":"PLAIN-ws-draft"}",
                  "format": "json",
                },
                "name": "ws",
                "protocols": [
                  "chat",
                ],
                "templates": [
                  {
                    "body": "PLAIN-ws-template",
                    "format": "text",
                    "name": "t",
                  },
                ],
                "type": "websocket",
                "url": "wss://ws.test/socket?access_token=&room={{room}}",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('socket.io rows', () => {
    expect(record(FIXTURES.socketioRows)).toMatchInlineSnapshot(`
      {
        "count": 5,
        "redacted": {
          "id": "c",
          "items": [
            {
              "id": "item",
              "name": "item",
              "request": {
                "emit": {
                  "ack": false,
                  "args": "[]",
                  "eventName": "e",
                },
                "handshakeAuth": [
                  {
                    "enabled": true,
                    "id": "anything",
                    "key": "anything",
                    "value": "",
                  },
                  {
                    "enabled": true,
                    "id": "ref",
                    "key": "ref",
                    "value": "{{tokenVar}}",
                  },
                  {
                    "enabled": true,
                    "id": "e",
                    "key": "e",
                    "value": "",
                  },
                ],
                "headers": [
                  {
                    "enabled": true,
                    "id": "Authorization",
                    "key": "Authorization",
                    "value": "",
                  },
                ],
                "id": "r",
                "name": "sio rows",
                "namespace": "/",
                "path": "/socket.io",
                "query": [
                  {
                    "enabled": true,
                    "id": "api_key",
                    "key": "api_key",
                    "value": "",
                  },
                  {
                    "enabled": true,
                    "id": "room",
                    "key": "room",
                    "value": "kept",
                  },
                ],
                "subscribedEvents": [],
                "templates": [],
                "transports": [
                  "websocket",
                ],
                "type": "socketio",
                "url": "https://sio.test?token=",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('socket.io json handshake', () => {
    expect(record(FIXTURES.socketioJson)).toMatchInlineSnapshot(`
      {
        "count": 2,
        "redacted": {
          "id": "c",
          "items": [
            {
              "id": "item",
              "name": "item",
              "request": {
                "emit": {
                  "ack": false,
                  "args": "[]",
                  "eventName": "e",
                },
                "handshakeAuth": [],
                "handshakeAuthJson": "{
        "token": "",
        "nested": {
          "n": "",
          "ref": "{{v}}"
        },
        "bare": {{bare}}
      }",
                "handshakeAuthMode": "json",
                "headers": [],
                "id": "r",
                "name": "sio json",
                "namespace": "/",
                "path": "/socket.io",
                "query": [],
                "subscribedEvents": [],
                "templates": [],
                "transports": [
                  "polling",
                ],
                "type": "socketio",
                "url": "https://sio.test",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('socket.io unparseable json handshake', () => {
    expect(record(FIXTURES.socketioUnparseableJson)).toMatchInlineSnapshot(`
      {
        "count": 1,
        "redacted": {
          "id": "c",
          "items": [
            {
              "id": "item",
              "name": "item",
              "request": {
                "emit": {
                  "ack": false,
                  "args": "[]",
                  "eventName": "e",
                },
                "handshakeAuth": [],
                "handshakeAuthJson": "",
                "headers": [],
                "id": "r",
                "name": "sio bad json",
                "namespace": "/",
                "path": "/socket.io",
                "query": [],
                "subscribedEvents": [],
                "templates": [],
                "transports": [],
                "type": "socketio",
                "url": "https://sio.test",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('sse', () => {
    expect(record(FIXTURES.sse)).toMatchInlineSnapshot(`
      {
        "count": 3,
        "redacted": {
          "id": "c",
          "items": [
            {
              "id": "item",
              "name": "item",
              "request": {
                "auth": {
                  "bearer": {
                    "token": "",
                  },
                  "type": "bearer",
                },
                "headers": [
                  {
                    "enabled": true,
                    "id": "Authorization",
                    "key": "Authorization",
                    "value": "",
                  },
                ],
                "id": "r",
                "name": "sse",
                "params": [
                  {
                    "enabled": true,
                    "id": "secret",
                    "key": "secret",
                    "value": "",
                  },
                ],
                "type": "sse",
                "url": "https://sse.test/events?token=PLAIN-sse-url",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('mcp http', () => {
    expect(record(FIXTURES.mcpHttp)).toMatchInlineSnapshot(`
      {
        "count": 2,
        "redacted": {
          "id": "c",
          "items": [
            {
              "id": "item",
              "name": "item",
              "request": {
                "auth": {
                  "oauth2": {
                    "accessToken": "",
                    "clientId": "kept-client",
                  },
                  "type": "oauth2",
                },
                "headers": [
                  {
                    "enabled": true,
                    "id": "X-MCP-Auth",
                    "key": "X-MCP-Auth",
                    "value": "",
                  },
                ],
                "id": "r",
                "name": "mcp",
                "transport": "streamable-http",
                "type": "mcp",
                "url": "https://user:PLAIN-mcp-pw@mcp.test/mcp",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('mcp stdio', () => {
    expect(record(FIXTURES.mcpStdio)).toMatchInlineSnapshot(`
      {
        "count": 4,
        "redacted": {
          "id": "c",
          "items": [
            {
              "id": "item",
              "name": "item",
              "request": {
                "auth": {
                  "type": "none",
                },
                "headers": [],
                "id": "r",
                "name": "mcp stdio",
                "stdio": {
                  "args": [
                    "server",
                    "--token",
                    "PLAIN-argv-not-walked",
                  ],
                  "command": "npx",
                  "env": [
                    {
                      "enabled": true,
                      "id": "LOG_LEVEL",
                      "key": "LOG_LEVEL",
                      "value": "debug",
                    },
                    {
                      "enabled": true,
                      "id": "API_TOKEN",
                      "key": "API_TOKEN",
                      "secret": true,
                      "value": "",
                    },
                    {
                      "enabled": true,
                      "id": "CUSTOM",
                      "key": "CUSTOM",
                      "secret": true,
                      "value": "",
                    },
                    {
                      "enabled": true,
                      "id": "INLINE_REF",
                      "key": "INLINE_REF",
                      "secretRef": {
                        "kind": "inline",
                        "value": "",
                      },
                      "value": "",
                    },
                    {
                      "enabled": true,
                      "id": "STRING_REF",
                      "key": "STRING_REF",
                      "secretRef": "",
                      "value": "",
                    },
                    {
                      "enabled": true,
                      "id": "HANDLE_REF",
                      "key": "HANDLE_REF",
                      "secretRef": {
                        "id": "h-1",
                        "kind": "handle",
                        "label": "kept",
                      },
                      "value": "",
                    },
                  ],
                },
                "transport": "stdio",
                "type": "mcp",
                "url": "",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('kafka', () => {
    expect(record(FIXTURES.kafka)).toMatchInlineSnapshot(`
      {
        "count": 3,
        "redacted": {
          "id": "c",
          "items": [
            {
              "id": "item",
              "name": "item",
              "request": {
                "connection": {
                  "acks": 1,
                  "bootstrapBrokers": [
                    "b1:9092",
                    "b2:9092",
                    "{{u}}:{{p}}@b3:9092",
                  ],
                  "clientId": "c",
                  "compression": "none",
                  "idempotent": false,
                  "registry": {
                    "url": "https://registry.test",
                  },
                  "sasl": {
                    "extensions": {
                      "token": "PLAIN-sasl-ext",
                    },
                    "mechanism": "PLAIN",
                    "username": "kept",
                  },
                  "securityProtocol": "SASL_SSL",
                },
                "consume": {
                  "groupId": "g",
                  "mode": "committed",
                  "topics": [],
                },
                "id": "r",
                "name": "kafka",
                "produce": {
                  "headers": [
                    {
                      "enabled": true,
                      "id": "x-api-key",
                      "key": "x-api-key",
                      "value": "",
                    },
                    {
                      "enabled": true,
                      "id": "trace",
                      "key": "trace",
                      "value": "kept",
                    },
                  ],
                  "key": "",
                  "keyEncoding": "utf8",
                  "topic": "t",
                  "value": "PLAIN-payload-kept",
                  "valueEncoding": "utf8",
                },
                "type": "kafka",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('kafka without registry or record headers', () => {
    expect(record(FIXTURES.kafkaNoRegistry)).toMatchInlineSnapshot(`
      {
        "count": 0,
        "redacted": {
          "id": "c",
          "items": [
            {
              "id": "item",
              "name": "item",
              "request": {
                "connection": {
                  "acks": 1,
                  "bootstrapBrokers": [],
                  "clientId": "c",
                  "compression": "none",
                  "idempotent": false,
                  "securityProtocol": "PLAINTEXT",
                },
                "consume": {
                  "groupId": "g",
                  "mode": "committed",
                  "topics": [],
                },
                "id": "r",
                "name": "kafka bare",
                "produce": {
                  "headers": [],
                  "key": "",
                  "keyEncoding": "utf8",
                  "topic": "t",
                  "value": "",
                  "valueEncoding": "utf8",
                },
                "type": "kafka",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('mqtt', () => {
    expect(record(FIXTURES.mqtt)).toMatchInlineSnapshot(`
      {
        "count": 3,
        "redacted": {
          "id": "c",
          "items": [
            {
              "id": "item",
              "name": "item",
              "request": {
                "connection": {
                  "autoReconnect": false,
                  "brokerUrl": "mqtts://broker.test:8883",
                  "cleanStart": true,
                  "clientId": "c",
                  "connectProperties": {
                    "userProperties": {
                      "password": "PLAIN-connect-prop",
                    },
                  },
                  "connectTimeout": 1000,
                  "keepalive": 60,
                  "lwt": {
                    "payload": "x",
                    "properties": {
                      "userProperties": {
                        "token": "PLAIN-lwt-prop",
                      },
                    },
                    "qos": 0,
                    "retain": false,
                    "topic": "w",
                  },
                  "protocolVersion": 5,
                },
                "id": "r",
                "name": "mqtt",
                "publish": {
                  "payload": "kept",
                  "qos": 0,
                  "retain": false,
                  "topic": "t",
                  "userProperties": {
                    "authorization": "",
                    "trace": "kept",
                  },
                },
                "subscribe": {
                  "qos": 0,
                  "topicFilter": "#",
                },
                "templates": [
                  {
                    "name": "with props",
                    "payload": "kept",
                    "qos": 0,
                    "retain": false,
                    "topic": "t",
                    "userProperties": {
                      "empty_token": "",
                      "x-api-key": "",
                    },
                  },
                  {
                    "name": "no props",
                    "payload": "kept",
                    "qos": 0,
                    "retain": false,
                    "topic": "t",
                  },
                ],
                "type": "mqtt",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('folder auth', () => {
    expect(record(FIXTURES.folderAuth)).toMatchInlineSnapshot(`
      {
        "count": 2,
        "redacted": {
          "id": "c",
          "items": [
            {
              "auth": {
                "digest": {
                  "password": "",
                  "username": "kept",
                },
                "type": "digest",
              },
              "id": "f",
              "items": [
                {
                  "auth": {
                    "type": "wsse",
                    "wsse": {
                      "password": "",
                      "username": "kept",
                    },
                  },
                  "id": "f2",
                  "items": [],
                  "name": "nested",
                  "type": "folder",
                },
              ],
              "name": "folder",
              "type": "folder",
              "variables": [
                {
                  "enabled": true,
                  "id": "folderSecret",
                  "key": "folderSecret",
                  "secret": true,
                  "value": "PLAIN-folder-variable-kept",
                },
              ],
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('collection auth', () => {
    expect(record(FIXTURES.collectionAuth)).toMatchInlineSnapshot(`
      {
        "count": 5,
        "redacted": {
          "auth": {
            "awsSignature": {
              "accessKey": "kept-access",
              "region": "us-east-1",
              "secretKey": "",
            },
            "ntlm": {
              "password": {
                "kind": "inline",
                "value": "",
              },
              "username": "kept",
            },
            "oauth1": {
              "accessToken": "",
              "accessTokenSecret": "",
              "consumerSecret": "",
            },
            "type": "aws-signature",
          },
          "id": "c",
          "items": [],
          "name": "c",
          "variables": [
            {
              "enabled": true,
              "id": "rootSecret",
              "key": "rootSecret",
              "secret": true,
              "value": "PLAIN-root-variable-kept",
            },
          ],
        },
        "residual": 0,
      }
    `);
  });
  it('handle references are preserved and not counted', () => {
    expect(record(FIXTURES.handles)).toMatchInlineSnapshot(`
      {
        "count": 0,
        "redacted": {
          "auth": {
            "basic": {
              "password": {
                "id": "h-root",
                "kind": "handle",
              },
              "username": "kept",
            },
            "type": "basic",
          },
          "id": "c",
          "items": [
            {
              "id": "item",
              "name": "item",
              "request": {
                "auth": {
                  "bearer": {
                    "token": {
                      "id": "h-req",
                      "kind": "handle",
                      "label": "req",
                    },
                  },
                  "type": "bearer",
                },
                "body": {
                  "type": "none",
                },
                "headers": [],
                "id": "r",
                "method": "GET",
                "name": "handles",
                "params": [],
                "type": "http",
                "url": "https://api.test",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('root _oc bag', () => {
    expect(record(FIXTURES.rootOc)).toMatchInlineSnapshot(`
      {
        "count": 14,
        "redacted": {
          "_oc": {
            "config": {
              "clientCertificates": [
                {
                  "passphrase": "",
                },
              ],
              "proxy": {
                "config": {
                  "auth": {
                    "password": "",
                    "username": "kept",
                  },
                },
              },
            },
            "environments": [
              {
                "name": "e",
                "variables": [
                  {
                    "name": "v",
                    "secret": true,
                    "value": "",
                  },
                ],
              },
            ],
            "extensions": {
              "x-restura-mcp": [
                {
                  "info": {
                    "name": "ext",
                    "type": "mcp",
                  },
                  "mcp": {
                    "auth": {
                      "token": "",
                      "type": "bearer",
                    },
                    "headers": [
                      {
                        "name": "X-Auth",
                        "value": "",
                      },
                    ],
                    "stdio": {
                      "command": "npx",
                      "env": [
                        {
                          "name": "API_KEY",
                          "secret": true,
                          "value": "",
                        },
                        {
                          "name": "REF",
                          "value": "",
                        },
                        {
                          "name": "HANDLE",
                          "secretRef": {
                            "id": "h-oc",
                            "kind": "handle",
                          },
                          "value": "",
                        },
                        {
                          "name": "LOG",
                          "value": "kept",
                        },
                      ],
                    },
                    "url": "https://mcp.test?token=",
                  },
                },
              ],
            },
            "info": {
              "name": "c",
            },
            "items": [
              {
                "http": {
                  "auth": {
                    "accessToken": "",
                    "credentials": {
                      "clientSecret": "",
                    },
                    "resourceOwner": {
                      "password": "",
                    },
                    "type": "oauth2",
                  },
                  "headers": [
                    {
                      "name": "Authorization",
                      "value": "",
                    },
                  ],
                  "url": "https://api.test?api_key=",
                },
                "info": {
                  "name": "typed copy",
                  "type": "http",
                },
              },
              {
                "http": {
                  "auth": {
                    "hawkId": "kept",
                    "password": "",
                    "type": "hawk",
                  },
                },
                "info": {
                  "name": "degrade",
                  "type": "http",
                },
              },
              {
                "http": {
                  "auth": {
                    "consumerSecret": "",
                    "privateKey": {
                      "type": "text",
                      "value": "",
                    },
                    "type": "oauth1",
                  },
                },
                "info": {
                  "name": "rsa",
                  "type": "http",
                },
              },
              {
                "http": {
                  "auth": {
                    "privateKey": {
                      "type": "file",
                      "value": "/kept/key.pem",
                    },
                    "type": "oauth1",
                  },
                },
                "info": {
                  "name": "rsa file",
                  "type": "http",
                },
              },
              {
                "info": {
                  "name": "opaque",
                  "type": "socketio",
                },
                "socketio": {
                  "auth": {
                    "token": "",
                    "type": "bearer",
                  },
                  "headers": [
                    {
                      "name": "X-Api-Key",
                      "value": "",
                    },
                    {
                      "name": "X-Ref",
                      "secret": true,
                      "value": "",
                    },
                    {
                      "name": "accept",
                      "value": "kept",
                    },
                  ],
                  "url": "https://sio.test",
                },
              },
              {
                "auth": {
                  "token": "",
                  "type": "bearer",
                },
                "info": {
                  "name": "auth opaque",
                  "type": "websocket",
                },
              },
            ],
          },
          "id": "c",
          "items": [
            {
              "_oc": {
                "auth": {
                  "password": "",
                  "type": "hawk",
                },
              },
              "id": "item",
              "name": "item",
              "request": {
                "auth": {
                  "bearer": {
                    "token": "",
                  },
                  "type": "bearer",
                },
                "body": {
                  "type": "none",
                },
                "headers": [
                  {
                    "enabled": true,
                    "id": "Authorization",
                    "key": "Authorization",
                    "value": "",
                  },
                ],
                "id": "r",
                "method": "GET",
                "name": "typed copy",
                "params": [],
                "type": "http",
                "url": "https://api.test",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('per-item _oc fallback when the root bag was stripped', () => {
    expect(record(FIXTURES.perItemOc)).toMatchInlineSnapshot(`
      {
        "count": 3,
        "redacted": {
          "id": "c",
          "items": [
            {
              "_oc": {
                "http": {
                  "auth": {
                    "credentials": {
                      "clientSecret": "",
                    },
                    "token": "",
                    "type": "bearer",
                  },
                  "headers": [
                    {
                      "name": "Authorization",
                      "value": "",
                    },
                  ],
                },
                "info": {
                  "type": "http",
                },
              },
              "id": "item",
              "name": "item",
              "request": {
                "auth": {
                  "type": "none",
                },
                "body": {
                  "type": "none",
                },
                "headers": [],
                "id": "r",
                "method": "GET",
                "name": "bag only",
                "params": [],
                "type": "http",
                "url": "https://api.test",
              },
              "type": "request",
            },
            {
              "_oc": {
                "auth": {
                  "token": "",
                  "type": "bearer",
                },
                "headers": [
                  {
                    "name": "X-Api-Key",
                    "value": "",
                  },
                ],
                "info": {
                  "type": "graphql-subscription",
                },
              },
              "id": "placeholder",
              "items": [],
              "name": "opaque placeholder",
              "type": "folder",
            },
            {
              "_oc": {
                "auth": {
                  "token": "",
                  "type": "bearer",
                },
              },
              "id": "real-folder",
              "items": [],
              "name": "real oc folder",
              "type": "folder",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('_postman sidecars on the root and per node', () => {
    expect(record(FIXTURES.postman)).toMatchInlineSnapshot(`
      {
        "count": 24,
        "redacted": {
          "_postman": {
            "auth": {
              "oauth2": {
                "accessToken": "",
                "tokenRequestParams": [
                  {
                    "key": "client_assertion",
                    "send_as": "body",
                    "value": "",
                  },
                ],
              },
              "type": "oauth2",
            },
            "variable": [
              {
                "key": "public",
                "value": "kept",
              },
            ],
          },
          "id": "c",
          "items": [
            {
              "_postman": {
                "auth": {
                  "hawk": [
                    {
                      "key": "authId",
                      "value": "",
                    },
                    {
                      "key": "authKey",
                      "value": "",
                    },
                  ],
                  "type": "hawk",
                },
                "authBagOnly": true,
                "body": {
                  "formdata": [
                    {
                      "key": "password",
                      "value": "",
                    },
                  ],
                },
                "item": {
                  "$kind": "mcp",
                  "argv": [
                    "run",
                    "",
                  ],
                  "command": "run --key ''",
                  "env": [
                    {
                      "key": "API_KEY",
                      "value": "",
                    },
                  ],
                },
                "response": [
                  {
                    "body": "",
                    "cookie": [
                      {
                        "name": "sid",
                        "value": "",
                      },
                    ],
                    "header": [
                      {
                        "key": "Set-Cookie",
                        "value": "",
                      },
                    ],
                    "name": "saved",
                    "originalRequest": {
                      "auth": {
                        "bearer": {
                          "token": "",
                        },
                        "type": "bearer",
                      },
                      "body": {
                        "mode": "raw",
                      },
                      "header": "Authorization: 
      Accept: kept",
                      "url": {
                        "auth": {
                          "password": "",
                          "user": "kept",
                        },
                        "query": [
                          {
                            "key": "token",
                            "value": "",
                          },
                        ],
                        "raw": "https://api.test?token=",
                      },
                    },
                  },
                  {
                    "header": {
                      "Accept": "kept",
                      "Authorization": "",
                    },
                    "name": "map headers",
                  },
                ],
                "scripts": [
                  {
                    "code": "fetch("https://x.test?token=")",
                  },
                ],
                "settings": {
                  "clientSecret": "",
                  "timeout": 5,
                },
                "urlVariable": [
                  {
                    "key": "k",
                    "type": "secret",
                    "value": "",
                  },
                ],
                "variable": [
                  {
                    "key": "token",
                    "value": "",
                  },
                ],
              },
              "id": "item",
              "name": "item",
              "request": {
                "auth": {
                  "bearer": {
                    "token": "",
                  },
                  "type": "bearer",
                },
                "body": {
                  "type": "none",
                },
                "headers": [],
                "id": "r",
                "method": "GET",
                "name": "pm",
                "params": [],
                "type": "http",
                "url": "https://api.test",
              },
              "type": "request",
            },
            {
              "_postman": {
                "auth": {
                  "jwt": {
                    "algorithm": "HS256",
                    "secret": "",
                  },
                  "type": "jwt",
                },
              },
              "id": "pm-folder",
              "items": [],
              "name": "pm folder",
              "type": "folder",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('both bags on one item', () => {
    expect(record(FIXTURES.bothBagsOnOneItem)).toMatchInlineSnapshot(`
      {
        "count": 2,
        "redacted": {
          "id": "c",
          "items": [
            {
              "_oc": {
                "http": {
                  "auth": {
                    "password": "",
                    "type": "hawk",
                  },
                },
              },
              "_postman": {
                "variable": [
                  {
                    "key": "token",
                    "value": "",
                  },
                ],
              },
              "id": "item",
              "name": "item",
              "request": {
                "auth": {
                  "type": "none",
                },
                "body": {
                  "type": "none",
                },
                "headers": [],
                "id": "r",
                "method": "GET",
                "name": "both",
                "params": [],
                "type": "http",
                "url": "https://api.test",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 0,
      }
    `);
  });
  it('mqtt with @ in the password', () => {
    expect(record(PINNED_VIOLATIONS.mqttAtSignInPassword)).toMatchInlineSnapshot(`
      {
        "count": 1,
        "redacted": {
          "id": "c",
          "items": [
            {
              "id": "item",
              "name": "item",
              "request": {
                "connection": {
                  "brokerUrl": "mqtt://tail@broker.test:1883",
                },
                "id": "r",
                "name": "mqtt @",
                "publish": {
                  "payload": "",
                  "qos": 0,
                  "retain": false,
                  "topic": "t",
                },
                "subscribe": {
                  "qos": 0,
                  "topicFilter": "#",
                },
                "templates": [],
                "type": "mqtt",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 1,
      }
    `);
  });
  it('kafka with @ in the password', () => {
    expect(record(PINNED_VIOLATIONS.kafkaAtSignInPassword)).toMatchInlineSnapshot(`
      {
        "count": 2,
        "redacted": {
          "id": "c",
          "items": [
            {
              "id": "item",
              "name": "item",
              "request": {
                "connection": {
                  "bootstrapBrokers": [
                    "tail@b1:9092",
                  ],
                  "registry": {
                    "url": "https://tail@registry.test",
                  },
                },
                "consume": {},
                "id": "r",
                "name": "kafka @",
                "produce": {
                  "headers": [],
                },
                "type": "kafka",
              },
              "type": "request",
            },
          ],
          "name": "c",
        },
        "residual": 2,
      }
    `);
  });
  it('external secret ref', () => {
    expect(record(PINNED_VIOLATIONS.externalSecretRef)).toMatchInlineSnapshot(`
      {
        "count": 1,
        "redacted": {
          "auth": {
            "bearer": {
              "token": {
                "kind": "external",
                "profileId": "p",
                "provider": "aws-secrets-manager",
                "secretId": "prod/token",
              },
            },
            "type": "bearer",
          },
          "id": "c",
          "items": [],
          "name": "c",
        },
        "residual": 1,
      }
    `);
  });
});

describe('root _oc versus per-item _oc counting', () => {
  const item = {
    id: 'r',
    name: 'r',
    type: 'folder',
    items: [],
    _oc: {
      info: { type: 'opaque' },
      auth: { type: 'bearer', token: 'PLAIN-item-bag' },
    },
  } as unknown as CollectionItem;

  it('counts the per-item bag only when the root bag is absent', () => {
    expect(countCollectionInlineSecrets(collectionOf([item]))).toBe(1);
    expect(countCollectionInlineSecrets(collectionOf([item], { _oc: { info: {} } }))).toBe(0);
  });

  it('treats a present-but-null root bag as present', () => {
    expect(countCollectionInlineSecrets(collectionOf([item], { _oc: null }))).toBe(0);
  });

  it('still redacts the per-item bag when the root bag is present', () => {
    const out = redactCollectionSecrets(collectionOf([item], { _oc: { info: {} } }));
    expect((out.items[0] as unknown as { _oc: { auth: { token: string } } })._oc.auth.token).toBe(
      ''
    );
  });
});

describe('depth overflow', () => {
  const secret = { auth: { type: 'bearer', bearer: { token: 'PLAIN-deep' } } };

  it('a secret at the last walked depth is counted and blanked, with no overflow', () => {
    const c = chain(256, secret);
    deepFreeze(c);
    expect(countCollectionInlineSecrets(c)).toBe(1);
    const out = redactCollectionSecrets(c);
    expect(itemAtDepth(out, 256).auth).toEqual({
      type: 'bearer',
      bearer: { token: '' },
    });
    expect(countCollectionInlineSecrets(out)).toBe(0);
  });

  it('counts an overflowing subtree as 1 and truncates it to a stub on redaction', () => {
    const c = chain(258, {
      ...secret,
      request: {
        type: 'http',
        headers: [row('Authorization', 'PLAIN-deep-header')],
      },
    });
    deepFreeze(c);
    expect(countCollectionInlineSecrets(c)).toBe(1);
    const out = redactCollectionSecrets(c);
    expect(JSON.stringify(out)).not.toContain('PLAIN');
    expect(itemAtDepth(out, 256).items).toHaveLength(1);
    expect(itemAtDepth(out, 257)).toMatchInlineSnapshot(`
      {
        "id": "n257",
        "items": [],
        "name": "n257",
        "type": "folder",
      }
    `);
  });

  it('the stub has no items key when the truncated node had none', () => {
    const out = redactCollectionSecrets(chain(257, { ...secret, extra: 'dropped' }));
    expect(itemAtDepth(out, 257)).toMatchInlineSnapshot(`
      {
        "id": "n257",
        "name": "n257",
        "type": "folder",
      }
    `);
  });

  it('an empty items array just past the bound still counts 1', () => {
    expect(countCollectionInlineSecrets(chain(256, { items: [] }))).toBe(1);
  });
});

describe('request slot edge cases', () => {
  const http = (fields: Record<string, unknown>) =>
    collectionOf([requestItem({ id: 'r', name: 'r', type: 'http', ...fields })]);
  const redactedRequest = (c: Collection) =>
    redactCollectionSecrets(c).items[0]?.request as unknown as Record<string, unknown>;

  it('copies the request even when it holds no secret', () => {
    const c = http({ headers: [] });
    expect(redactCollectionSecrets(c).items[0]?.request).not.toBe(c.items[0]?.request);
  });

  it('returns the same row object for a row that needs no blanking', () => {
    const accept = row('Accept', 'x');
    const out = redactedRequest(http({ headers: [accept] }));
    expect((out.headers as unknown[])[0]).toBe(accept);
  });

  it('leaves absent fields absent', () => {
    expect(Object.keys(redactedRequest(http({})))).toEqual(['id', 'name', 'type']);
  });

  it('redacts a present-but-undefined auth into an empty object', () => {
    const c = http({ auth: undefined });
    expect(redactedRequest(c).auth).toEqual({});
    expect(countCollectionInlineSecrets(c)).toBe(0);
  });

  it('non-array row lists: passed through by redact; a truthy one makes count throw', () => {
    const map = { Authorization: 'PLAIN-map' };
    const c = http({ headers: map });
    expect(redactedRequest(c).headers).toBe(map);
    expect(() => countCollectionInlineSecrets(c)).toThrow(TypeError);
    const nullRows = http({ headers: null, params: null, metadata: null });
    expect(redactedRequest(nullRows).headers).toBeNull();
    expect(countCollectionInlineSecrets(nullRows)).toBe(0);
  });

  it('a form body whose formData is not an array is untouched and uncounted', () => {
    const body = { type: 'form-data', formData: 'PLAIN-string' };
    const c = http({ body });
    expect(redactedRequest(c).body).toBe(body);
    expect(countCollectionInlineSecrets(c)).toBe(0);
  });

  it('a form body with no secret still gets a fresh formData array, keeping file rows', () => {
    const file = row('password', 'PLAIN-file', { type: 'file' });
    const body = { type: 'form-data', formData: [file] };
    const out = redactedRequest(http({ body })).body as typeof body;
    expect(out).not.toBe(body);
    expect(out.formData).not.toBe(body.formData);
    expect(out.formData[0]).toBe(file);
    expect(countCollectionInlineSecrets(http({ body }))).toBe(0);
  });

  it('stdio without an env array is untouched', () => {
    const stdio = { command: 'npx', args: [], env: 'junk' };
    const c = collectionOf([requestItem({ id: 'r', name: 'r', type: 'mcp', stdio })]);
    expect(redactedRequest(c).stdio).toBe(stdio);
    expect(countCollectionInlineSecrets(c)).toBe(0);
  });

  it('a malformed preset makes both walks throw rather than pass it through', () => {
    const kafka = collectionOf([requestItem({ id: 'r', name: 'r', type: 'kafka' })]);
    expect(() => redactCollectionSecrets(kafka)).toThrow(TypeError);
    expect(() => countCollectionInlineSecrets(kafka)).toThrow(TypeError);
    const socket = collectionOf([requestItem({ id: 'r', name: 'r', type: 'socketio' })]);
    expect(() => redactCollectionSecrets(socket)).toThrow(TypeError);
    expect(() => countCollectionInlineSecrets(socket)).toThrow(TypeError);
  });

  it('an empty handshakeAuthJson is kept and a null one only throws on redaction', () => {
    const sio = (handshakeAuthJson: unknown) =>
      collectionOf([
        requestItem({
          id: 'r',
          name: 'r',
          type: 'socketio',
          url: 'https://s.test',
          handshakeAuth: [],
          handshakeAuthJson,
          query: [],
        }),
      ]);
    expect(redactedRequest(sio('')).handshakeAuthJson).toBe('');
    expect(countCollectionInlineSecrets(sio(''))).toBe(0);
    expect(() => redactCollectionSecrets(sio(null))).toThrow(TypeError);
    expect(countCollectionInlineSecrets(sio(null))).toBe(0);
  });

  it('adds empty row lists a preset is missing', () => {
    const out = redactedRequest(FIXTURES.kafkaNoRegistry) as {
      produce: { headers: unknown[] };
    };
    expect(out.produce.headers).toEqual([]);
    const sio = collectionOf([
      requestItem({
        id: 'r',
        name: 'r',
        type: 'socketio',
        url: 'u',
        handshakeAuth: [],
      }),
    ]);
    expect(redactedRequest(sio).query).toEqual([]);
  });

  it('non-request items pass through, and a falsy request is left alone', () => {
    const out = redactCollectionSecrets(collectionOf([requestItem(null as never)]));
    expect(out.items[0]?.request).toBeNull();
    expect(countCollectionInlineSecrets(collectionOf([requestItem(null as never)]))).toBe(0);
  });
});

describe('count(redact(c)) === 0', () => {
  it.each(Object.entries(FIXTURES))('%s', (_name, collection) => {
    expect(countCollectionInlineSecrets(redactCollectionSecrets(collection))).toBe(0);
  });

  /**
   * Real violations on the pre-refactor code, pinned rather than fixed. When a
   * fix lands this fails: move the fixture up and update its snapshot.
   */
  describe('known violations', () => {
    it.fails.each(Object.entries(PINNED_VIOLATIONS))('%s', (_name, collection) => {
      expect(countCollectionInlineSecrets(redactCollectionSecrets(collection))).toBe(0);
    });

    it.fails('depth overflow: the truncation stub is counted again', () => {
      const out = redactCollectionSecrets(chain(258, {}));
      expect(countCollectionInlineSecrets(out)).toBe(0);
    });
  });
});
