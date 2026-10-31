import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importOpenCollection } from '@/features/collections/lib/importers/opencollection';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';
import type { CollectionItem } from '@/types';
import {
  ECHO_BASE,
  SAMPLE_PROTOCOLS,
  type SampleProtocol,
  sampleFileName,
  serializeSample,
} from '../../scripts/docs-samples.mts';

// The docs "Try it" samples (#1013) promise "import → Send → it works" against
// the public echo server. Import each through the real OpenCollection importer.

// WebSocket items import as connection presets, not tab requests, so read the
// saved request off the item directly rather than via tests/helpers/requestOf.
type Saved = NonNullable<CollectionItem['request']>;

function flatten(items: CollectionItem[]): Saved[] {
  const out: Saved[] = [];
  for (const it of items) {
    if (it.type === 'request' && it.request) out.push(it.request);
    if (it.items) out.push(...flatten(it.items));
  }
  return out;
}

const EXPECTED_TYPE: Record<SampleProtocol, Saved['type']> = {
  http: 'http',
  // GraphQL imports as an HTTP request with a graphql body.
  graphql: 'http',
  grpc: 'grpc',
  websocket: 'websocket',
  sse: 'sse',
};

describe('docs Try-it sample collections', () => {
  it('uses the same echo host as the app defaults', () => {
    expect(ECHO_URLS.http.startsWith(ECHO_BASE)).toBe(true);
    expect(ECHO_URLS.sse).toBe(`${ECHO_BASE}/sse`);
    expect(ECHO_URLS.graphql).toBe(`${ECHO_BASE}/graphql`);
  });

  for (const protocol of SAMPLE_PROTOCOLS) {
    describe(protocol, () => {
      const text = serializeSample(protocol);

      it('is committed and up to date in docs-site/public/samples', () => {
        const path = join(
          process.cwd(),
          'docs-site',
          'public',
          'samples',
          sampleFileName(protocol)
        );
        expect(readFileSync(path, 'utf8')).toBe(text);
      });

      it('imports with no warnings into runnable requests of the right type', () => {
        const { collection, warnings } = importOpenCollection(JSON.parse(text));
        expect(warnings).toEqual([]);
        const requests = flatten(collection.items);
        expect(requests.length).toBeGreaterThan(0);
        for (const request of requests) {
          expect(request.type).toBe(EXPECTED_TYPE[protocol]);
          const url = 'url' in request ? request.url : '';
          expect(url.startsWith(ECHO_BASE) || url.startsWith('wss://echo.restura.dev/')).toBe(true);
        }
        if (protocol === 'graphql') {
          expect(requests.every((r) => r.type === 'http' && r.body?.type === 'graphql')).toBe(true);
        }
      });
    });
  }
});
