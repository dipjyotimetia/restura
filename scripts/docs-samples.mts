// Docs "Try it" sample collections (#1013).
//
// Each protocol page on docs.restura.dev offers a ready-made OpenCollection
// that points at the public echo server (echo/, served at echo.restura.dev),
// so a reader can import it and click Send instead of typing URLs by hand.
//
// The files are served from docs-site/public/samples/ and are generated here so
// they cannot drift from what the echo server actually exposes:
//   node scripts/docs-samples.mts           # (re)write the files
//   node scripts/docs-samples.mts --check   # CI: fail when a file is stale
//
// tests/docs/docs-samples.test.ts imports every sample through the real
// OpenCollection importer and requires zero warnings, so a schema change that
// would break "import → Send" fails the test suite.
//
// Only protocols the public echo server serves are included: HTTP, GraphQL,
// gRPC (Connect + reflection), WebSocket and SSE. Socket.IO, Kafka, MQTT and
// MCP have no public echo; their pages point at the local stack instead
// (`npm run echo:local`, docs-site/src/content/docs/testing/local-stack.mdx).
//
// Plain objects only (no src/ import) so the script runs under bare Node.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Json = Record<string, unknown>;

/** Must match ECHO_BASE in src/lib/shared/echo-defaults.ts. */
export const ECHO_BASE = 'https://echo.restura.dev';
const ECHO_WS = 'wss://echo.restura.dev/ws';

export const SAMPLE_PROTOCOLS = ['http', 'graphql', 'grpc', 'websocket', 'sse'] as const;
export type SampleProtocol = (typeof SAMPLE_PROTOCOLS)[number];

function collection(name: string, items: Json[], extensions?: Json): Json {
  return {
    opencollection: '1.0.0',
    info: { name, version: '1.0.0' },
    bundled: true,
    items,
    ...(extensions ? { extensions } : {}),
  };
}

function httpItem(seq: number, name: string, http: Json): Json {
  return { info: { type: 'http', name, seq }, http };
}

export function buildSample(protocol: SampleProtocol): Json {
  switch (protocol) {
    case 'http':
      return collection('Restura echo — HTTP', [
        httpItem(1, 'GET with a query parameter', {
          method: 'GET',
          url: `${ECHO_BASE}/get?hello=world`,
        }),
        httpItem(2, 'POST a JSON body', {
          method: 'POST',
          url: `${ECHO_BASE}/anything`,
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          body: { raw: { format: 'json', value: JSON.stringify({ hello: 'world' }, null, 2) } },
        }),
      ]);
    case 'graphql':
      return collection('Restura echo — GraphQL', [
        {
          info: { type: 'graphql', name: 'Echo query' },
          graphql: {
            url: `${ECHO_BASE}/graphql`,
            query:
              'query Echo($message: String!) {\n  echo(message: $message) {\n    message\n    operation\n    timestamp\n  }\n}',
            variables: JSON.stringify({ message: 'hello' }, null, 2),
          },
        },
      ]);
    case 'grpc':
      return collection('Restura echo — gRPC', [
        {
          info: { type: 'grpc', name: 'EchoService/UnaryEcho' },
          grpc: {
            url: ECHO_BASE,
            service: 'echo.v1.EchoService',
            method: 'UnaryEcho',
            methodType: 'unary',
            message: JSON.stringify({ message: 'hello', count: 3 }, null, 2),
          },
        },
      ]);
    case 'websocket':
      return collection('Restura echo — WebSocket', [
        {
          info: { type: 'websocket', name: 'Echo socket' },
          websocket: {
            url: ECHO_WS,
            message: { type: 'json', data: JSON.stringify({ hello: 'world' }) },
          },
        },
      ]);
    case 'sse':
      return collection('Restura echo — SSE', [], {
        'x-restura-sse': [
          { info: { type: 'sse', name: 'Echo event stream' }, sse: { url: `${ECHO_BASE}/sse` } },
        ],
      });
  }
}

export function sampleFileName(protocol: SampleProtocol): string {
  return `${protocol}.opencollection.json`;
}

export function serializeSample(protocol: SampleProtocol): string {
  return `${JSON.stringify(buildSample(protocol), null, 2)}\n`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const outDir = join(root, 'docs-site', 'public', 'samples');
  const check = process.argv.includes('--check');
  const stale: string[] = [];
  if (!check) mkdirSync(outDir, { recursive: true });
  for (const protocol of SAMPLE_PROTOCOLS) {
    const path = join(outDir, sampleFileName(protocol));
    const expected = serializeSample(protocol);
    if (check) {
      let current = '';
      try {
        current = readFileSync(path, 'utf8');
      } catch {
        // missing counts as stale
      }
      if (current !== expected) stale.push(path);
    } else {
      writeFileSync(path, expected);
    }
  }
  if (stale.length > 0) {
    console.error(
      `docs-samples: ${stale.length} stale sample collection(s):\n  ${stale.join('\n  ')}\nRun: npm run docs:samples`
    );
    process.exit(1);
  }
  console.log(
    check
      ? 'docs-samples: sample collections are up to date.'
      : `docs-samples: wrote ${SAMPLE_PROTOCOLS.length} sample collections to ${outDir}`
  );
}
