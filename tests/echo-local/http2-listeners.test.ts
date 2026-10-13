import { describe, expect, it } from 'vitest';
import { importOpenCollection } from '@/features/collections/lib/importers/opencollection';
import type { CollectionItem, HttpRequest } from '@/types';
import { buildCollection } from '../../echo-local/collection';
import { buildManifest } from '../../echo-local/manifest';
import { IN_PROCESS_SERVICES, PORTS, TLS_SERVICES } from '../../echo-local/ports';

// #864: echo-local hosts an h2c (prior-knowledge) listener and an h2-over-TLS
// listener so the desktop HTTP-version setting can be exercised by hand, and
// ships requests pre-set to the matching httpVersion.

function httpByName(items: CollectionItem[], name: string): HttpRequest | undefined {
  for (const it of items) {
    if (it.type === 'request' && it.name === name && it.request?.type === 'http') {
      return it.request;
    }
    const nested = it.items ? httpByName(it.items, name) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

describe('echo-local HTTP/2 listeners', () => {
  it('registers h2c (cleartext) and h2 (TLS) as in-process services on stable ports', () => {
    expect(IN_PROCESS_SERVICES).toContain('h2c');
    expect(IN_PROCESS_SERVICES).toContain('h2');
    expect(TLS_SERVICES.has('h2')).toBe(true);
    expect(TLS_SERVICES.has('h2c')).toBe(false);
    expect(PORTS.h2c).toBe(8090);
    expect(PORTS.h2).toBe(8446);
  });

  it('lists both endpoints in the manifest', () => {
    const { endpoints } = buildManifest({ host: 'localhost' });
    expect(endpoints.h2c).toContain('http://localhost:8090');
    expect(endpoints.h2).toContain('https://localhost:8446');
  });

  it('ships requests pre-set to the matching HTTP version', () => {
    const { collection } = importOpenCollection(buildCollection());
    const h2c = httpByName(collection.items, 'HTTP/2 cleartext (h2c prior knowledge)');
    expect(h2c?.url).toBe('http://localhost:8090/');
    expect(h2c?.settings?.httpVersion).toBe('h2c-prior-knowledge');
    const forced = httpByName(collection.items, 'HTTP/1.1 forced against an h2 server');
    expect(forced?.url).toBe('https://localhost:8446/');
    expect(forced?.settings?.httpVersion).toBe('http1.1');
  });
});
