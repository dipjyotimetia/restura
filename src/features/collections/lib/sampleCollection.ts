import { v4 as uuidv4 } from 'uuid';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';
import type { Collection, CollectionItem, Request } from '@/types';

export const SAMPLE_COLLECTION_NAME = 'Restura Echo (sample)';

const item = (request: Request): CollectionItem => ({
  id: uuidv4(),
  name: request.name,
  type: 'request',
  request,
});

/**
 * A ready-to-run collection against the public echo server (or the
 * VITE_ECHO_* overrides on self-hosted builds), showing a folder, a
 * collection variable, a test script and one request per savable protocol.
 * WebSocket and Socket.IO are tab modes, not saved requests, so they aren't
 * included; Kafka and MQTT need a broker.
 */
export function buildSampleCollection(): Collection {
  const http: CollectionItem = {
    id: uuidv4(),
    name: 'HTTP',
    type: 'folder',
    items: [
      item({
        id: uuidv4(),
        name: 'Echo a GET',
        type: 'http',
        method: 'GET',
        url: ECHO_URLS.http,
        headers: [],
        params: [{ id: uuidv4(), key: 'hello', value: 'world', enabled: true }],
        body: { type: 'none' },
        auth: { type: 'none' },
        testScript: "rs.test('responds 200', () => rs.expect(rs.response.code).to.equal(200));",
      }),
      item({
        id: uuidv4(),
        name: 'Echo a JSON POST',
        type: 'http',
        method: 'POST',
        url: ECHO_URLS.http,
        headers: [{ id: uuidv4(), key: 'Content-Type', value: 'application/json', enabled: true }],
        params: [],
        body: { type: 'json', raw: '{\n  "greeting": "{{greeting}}"\n}' },
        auth: { type: 'none' },
      }),
    ],
  };

  return {
    id: uuidv4(),
    name: SAMPLE_COLLECTION_NAME,
    description:
      'A tour of Restura against the echo server: send each request to see its response. ' +
      'The JSON POST uses the `{{greeting}}` collection variable (Collection settings → Variables), ' +
      'and the GET has a test script. Delete the collection whenever you like.',
    variables: [{ id: uuidv4(), key: 'greeting', value: 'hello from Restura', enabled: true }],
    items: [
      http,
      item({
        id: uuidv4(),
        name: 'GraphQL query',
        type: 'http',
        method: 'POST',
        url: ECHO_URLS.graphql,
        headers: [],
        params: [],
        body: {
          type: 'graphql',
          raw: 'query Echo {\n  echo(message: "hello") {\n    message\n    operation\n    timestamp\n  }\n}',
        },
        auth: { type: 'none' },
      }),
      item({
        id: uuidv4(),
        name: 'gRPC unary echo',
        type: 'grpc',
        methodType: 'unary',
        url: ECHO_URLS.grpc,
        service: 'echo.v1.EchoService',
        method: 'UnaryEcho',
        metadata: [],
        message: '{\n  "message": "hello"\n}',
        auth: { type: 'none' },
      }),
      item({
        id: uuidv4(),
        name: 'SSE stream',
        type: 'sse',
        url: ECHO_URLS.sse,
        headers: [],
        params: [],
        auth: { type: 'none' },
        reconnectOnResume: true,
      }),
    ],
  };
}
