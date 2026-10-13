import { describe, expect, it } from 'vitest';
import type { Collection, CollectionItem, HttpRequest, RequestSettings } from '../types';
import { internalToOC } from './from-internal';
import { applyHttpExtension, HTTP_EXTENSION_KEY } from './http-settings-extension';
import { parseOpenCollectionYAML, serializeOpenCollectionYAML } from './serializer';
import { ocToInternal } from './to-internal';

const BASE: RequestSettings = {
  timeout: 30000,
  followRedirects: true,
  maxRedirects: 10,
  verifySsl: true,
};

function http(name: string, settings?: RequestSettings): HttpRequest {
  return {
    id: `id-${name}`,
    name,
    type: 'http',
    method: 'GET',
    url: 'http://localhost:8090/v',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...(settings ? { settings } : {}),
  };
}

const item = (r: HttpRequest): CollectionItem => ({
  id: `item-${r.name}`,
  type: 'request',
  name: r.name,
  request: r,
});

function fixture(): Collection {
  return {
    id: 'c',
    name: 'HTTP versions',
    items: [
      item(http('Forced 1.1', { ...BASE, httpVersion: 'http1.1' })),
      {
        id: 'f',
        type: 'folder',
        name: 'Cleartext',
        items: [item(http('Prior knowledge', { ...BASE, httpVersion: 'h2c-prior-knowledge' }))],
      },
      item(http('Auto', { ...BASE, httpVersion: 'auto' })),
      item(http('Plain')),
    ],
  };
}

function byName(items: CollectionItem[] | undefined, out = new Map<string, HttpRequest>()) {
  for (const it of items ?? []) {
    if (it.type === 'folder') byName(it.items, out);
    else if (it.request?.type === 'http') out.set(it.name, it.request);
  }
  return out;
}

describe('x-restura-http extension (httpVersion)', () => {
  it('exports non-auto httpVersion keyed by node path, outside the strict HTTP item', () => {
    const oc = internalToOC(fixture());
    const ext = (oc.extensions as Record<string, unknown>)[HTTP_EXTENSION_KEY];
    expect(ext).toEqual({
      requests: [
        { path: ['Forced 1.1'], httpVersion: 'http1.1' },
        { path: ['Cleartext', 'Prior knowledge'], httpVersion: 'h2c-prior-knowledge' },
      ],
    });
    // OC's HttpRequest/HttpRequestSettings are additionalProperties:false.
    expect(JSON.stringify(oc.items)).not.toContain('httpVersion');
  });

  it('omits the extension when every request is auto', () => {
    const oc = internalToOC({ id: 'c', name: 'n', items: [item(http('Plain'))] });
    expect((oc.extensions as Record<string, unknown> | undefined)?.[HTTP_EXTENSION_KEY]).toBe(
      undefined
    );
  });

  it('round-trips httpVersion through YAML', () => {
    const yaml = serializeOpenCollectionYAML(internalToOC(fixture()));
    const back = byName(ocToInternal(parseOpenCollectionYAML(yaml)).items);
    expect(back.get('Forced 1.1')?.settings?.httpVersion).toBe('http1.1');
    expect(back.get('Prior knowledge')?.settings?.httpVersion).toBe('h2c-prior-knowledge');
    expect(back.get('Auto')?.settings?.httpVersion).toBeUndefined();
    expect(back.get('Plain')?.settings).toBeUndefined();
  });

  it('imports only httpVersion as a partial override — no pinned timeout/redirect/TLS defaults', () => {
    const yaml = serializeOpenCollectionYAML(internalToOC(fixture()));
    const back = byName(ocToInternal(parseOpenCollectionYAML(yaml)).items);
    // Everything else keeps following the workspace defaults at send time.
    expect(back.get('Forced 1.1')?.settings).toEqual({ httpVersion: 'http1.1' });
  });

  it('keeps an existing override intact and only adds httpVersion', () => {
    const items = [item(http('X', { ...BASE, timeout: 1234 }))];
    applyHttpExtension(items, { requests: [{ path: ['X'], httpVersion: 'http2' }] });
    const req = items[0]!.request as HttpRequest;
    expect(req.settings).toEqual({ ...BASE, timeout: 1234, httpVersion: 'http2' });
  });

  it('ignores malformed entries and unknown literals', () => {
    const oc = internalToOC({ id: 'c', name: 'n', items: [item(http('A')), item(http('B'))] });
    oc.extensions = {
      [HTTP_EXTENSION_KEY]: {
        requests: [
          { path: ['A'], httpVersion: 'http3' },
          { path: 'B', httpVersion: 'http2' },
          null,
        ],
      },
    };
    const back = byName(ocToInternal(oc).items);
    expect(back.get('A')?.settings).toBeUndefined();
    expect(back.get('B')?.settings).toBeUndefined();
  });
});
