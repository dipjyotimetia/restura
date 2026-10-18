// #896 (SEC-3): on web, MCP credentials must never reach IndexedDB in
// plaintext. Exercises the REAL persistence pipeline — store → partialize →
// real Dexie adapter → (fake) IndexedDB — and inspects the raw stored rows.
import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('@/lib/shared/dexie-storage');

import { db } from '@/lib/shared/database';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useRequestStore } from '@/store/useRequestStore';
import type { Collection, McpRequest } from '@/types';
import { useMcpStore } from '../../../features/mcp/store/useMcpStore';
import {
  redactMcpCollectionsForWebPersistence,
  redactMcpRequestForWebPersistence,
} from '../mcpWebPersistence';

const TOKEN = 'web-plaintext-mcp-token-789';
const HEADER_TOKEN = 'web-plaintext-header-secret-012';
const URL_SECRET = 'web-plaintext-url-secret-345';

function mcpRequest(id = 'mcp-req-1'): McpRequest {
  return {
    id,
    name: 'Remote MCP',
    type: 'mcp',
    url: `https://user:${URL_SECRET}@mcp.example.com/mcp?api_key=${URL_SECRET}`,
    transport: 'streamable-http',
    headers: [
      { id: 'h1', key: 'Authorization', value: `Bearer ${HEADER_TOKEN}`, enabled: true },
      { id: 'h0', key: 'X-Auth', value: HEADER_TOKEN, enabled: true },
      { id: 'h2', key: 'X-Tenant', value: 'tenant-visible', enabled: true },
    ],
    auth: { type: 'bearer', bearer: { token: { kind: 'inline', value: TOKEN } } },
  };
}

async function rawRow(
  table: 'mcpConnections' | 'requestTabs' | 'collections',
  key: string
): Promise<string> {
  let data = '';
  await vi.waitFor(
    async () => {
      const row = (await db[table].get(key)) as { encryptedData?: string } | undefined;
      expect(row?.encryptedData).toContain('tenant-visible');
      data = row?.encryptedData ?? '';
    },
    { timeout: 5000 }
  );
  return data;
}

describe('MCP credentials are not persisted to web IndexedDB (#896)', () => {
  beforeEach(async () => {
    await db.clearAllData();
  });

  afterAll(async () => {
    await db.delete();
  });

  it('MCP connection profile headers are stored redacted', async () => {
    const id = useMcpStore.getState().createConnection(mcpRequest().url);
    useMcpStore.getState().setHeaders(id, mcpRequest().headers);
    // In-memory state keeps the credential for this session.
    expect(useMcpStore.getState().connections[id]?.headers[0]?.value).toContain(HEADER_TOKEN);

    const stored = await rawRow('mcpConnections', 'mcp-storage');
    expect(stored).not.toContain(HEADER_TOKEN);
    expect(stored).not.toContain(URL_SECRET);
  });

  it('MCP request tabs are stored without header or auth plaintext', async () => {
    useRequestStore.getState().openTab(mcpRequest('tab-req'), { switchTo: true });

    const stored = await rawRow('requestTabs', 'request-storage');
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain(HEADER_TOKEN);
    expect(stored).not.toContain(URL_SECRET);
  });

  it('saved MCP requests in collections are stored without plaintext', async () => {
    const collection: Collection = {
      id: 'col-1',
      name: 'Saved',
      items: [{ id: 'item-1', name: 'Remote MCP', type: 'request', request: mcpRequest('saved') }],
    } as Collection;
    useCollectionStore.getState().addCollection(collection);
    // The in-memory collection is untouched (the session keeps working).
    expect(JSON.stringify(useCollectionStore.getState().collections)).toContain(TOKEN);

    const stored = await rawRow('collections', 'collection-storage');
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain(HEADER_TOKEN);
    expect(stored).not.toContain(URL_SECRET);
  });
});

describe('desktop passthrough', () => {
  beforeEach(() => {
    (window as { electron?: unknown }).electron = { isElectron: true };
  });
  afterEach(() => {
    delete (window as { electron?: unknown }).electron;
  });

  it('keeps credentials on desktop (encrypted at rest with a keychain-wrapped key)', () => {
    const request = mcpRequest();
    expect(redactMcpRequestForWebPersistence(request)).toBe(request);
    const collections = [{ id: 'c', name: 'C', items: [] }] as unknown as Collection[];
    expect(redactMcpCollectionsForWebPersistence(collections)).toBe(collections);
  });
});

describe('non-MCP requests', () => {
  it('are passed through unchanged on web', () => {
    const http = { ...mcpRequest(), type: 'http' } as unknown as McpRequest;
    expect(redactMcpRequestForWebPersistence(http)).toBe(http);
  });
});
