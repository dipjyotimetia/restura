import { describe, it, expect } from 'vitest';
import { importPostmanCollection } from '../importers/postman';
import { exportToPostman } from '../exporters';
import type { PostmanCollection, HttpRequest, Collection } from '@/types';

function asHttp(item: { request?: unknown }): HttpRequest {
  return item.request as HttpRequest;
}

function prereqEvent(code: string) {
  return { listen: 'prerequest', script: { type: 'text/javascript', exec: code.split('\n') } };
}
function testEvent(code: string) {
  return { listen: 'test', script: { type: 'text/javascript', exec: code.split('\n') } };
}

const importData = (overrides: Partial<PostmanCollection>): PostmanCollection =>
  ({
    info: {
      name: 'Scripts',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [],
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostmanCollection type is loose
  }) as any;

describe('Postman import — pm.* -> rs.* migration', () => {
  it('migrates request-level pre-request and test scripts', async () => {
    const data = importData({
      item: [
        {
          name: 'Req',
          request: { method: 'GET', url: 'https://api.example.com', header: [] },
          event: [
            prereqEvent('pm.variables.set("t", Date.now());'),
            testEvent('pm.test("ok", () => pm.expect(pm.response.code).to.equal(200));'),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose
          ] as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose
        } as any,
      ],
    });
    const collection = await importPostmanCollection(data);
    const req = asHttp(collection.items[0]!);
    expect(req.preRequestScript).toBe('rs.variables.set("t", Date.now());');
    expect(req.testScript).toContain('rs.test("ok"');
    expect(req.testScript).toContain('rs.expect(rs.response.code)');
    expect(req.testScript).not.toMatch(/\bpm\./);
  });

  it('migrates collection-level scripts', async () => {
    const data = importData({
      event: [prereqEvent('pm.variables.set("base", "v1");'), testEvent('pm.test("c", () => {});')],
      item: [{ name: 'Req', request: { method: 'GET', url: 'https://x', header: [] } }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose
    } as any);
    const collection = await importPostmanCollection(data);
    expect(collection.preRequestScript).toBe('rs.variables.set("base", "v1");');
    expect(collection.testScript).toContain('rs.test("c"');
  });

  it('migrates folder-level scripts', async () => {
    const data = importData({
      item: [
        {
          name: 'Folder',
          event: [prereqEvent('pm.environment.set("k", "v");')],
          item: [{ name: 'Req', request: { method: 'GET', url: 'https://x', header: [] } }],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose
        } as any,
      ],
    });
    const collection = await importPostmanCollection(data);
    const folder = collection.items[0]!;
    expect(folder.type).toBe('folder');
    expect(folder.preRequestScript).toBe('rs.environment.set("k", "v");');
  });
});

describe('Postman export — rs.* -> pm.* reverse migration', () => {
  const collection: Collection = {
    id: 'c1',
    name: 'Export',
    preRequestScript: 'rs.variables.set("c", 1);',
    testScript: 'rs.test("col", () => {});',
    items: [
      {
        id: 'f1',
        name: 'Folder',
        type: 'folder',
        preRequestScript: 'rs.variables.set("f", 1);',
        items: [
          {
            id: 'r1',
            name: 'Req',
            type: 'request',
            request: {
              id: 'r1',
              name: 'Req',
              type: 'http',
              method: 'GET',
              url: 'https://x',
              headers: [],
              params: [],
              body: { type: 'none' },
              auth: { type: 'none' },
              preRequestScript: 'rs.variables.set("r", 1);',
              testScript: 'rs.test("req", () => rs.expect(1).to.equal(1));',
            },
          },
        ],
      },
    ],
  };

  it('reverse-migrates scripts at request, folder, and collection level', () => {
    const out = exportToPostman(collection);
    // collection level
    expect(out.event?.[0]?.script.exec.join('\n')).toBe('pm.variables.set("c", 1);');
    // folder level
    const folder = out.item[0]!;
    expect(folder.event?.[0]?.script.exec.join('\n')).toBe('pm.variables.set("f", 1);');
    // request level
    const req = folder.item![0]!;
    const pre = req.event?.find((e) => e.listen === 'prerequest');
    const test = req.event?.find((e) => e.listen === 'test');
    expect(pre?.script.exec.join('\n')).toBe('pm.variables.set("r", 1);');
    expect(test?.script.exec.join('\n')).toContain('pm.test("req"');
    expect(test?.script.exec.join('\n')).not.toMatch(/\brs\./);
  });
});

describe('Postman round-trip', () => {
  it('import (pm->rs) then export (rs->pm) restores the original pm.* scripts', async () => {
    const original = 'pm.test("Status", () => pm.expect(pm.response.code).to.equal(200));';
    const data = importData({
      item: [
        {
          name: 'Req',
          request: { method: 'GET', url: 'https://x', header: [] },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose
          event: [testEvent(original)] as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose
        } as any,
      ],
    });
    const imported = await importPostmanCollection(data);
    const exported = exportToPostman(imported);
    const test = exported.item[0]?.event?.find((e) => e.listen === 'test');
    expect(test?.script.exec.join('\n')).toBe(original);
  });
});
