// @vitest-environment node
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { importPostmanCollection } from '../../shared/collections/postman';
import { unzipPostmanV3Archive } from '../../shared/collections/postman/v3-archive';
import {
  PostmanV3ContainerError,
  readPostmanV3Container,
} from '../../shared/collections/postman/v3-container';
import { redactCollectionSecrets } from '../../shared/secrets/collection-redaction';

/**
 * #1200: a Postman v3 import reads an untrusted folder / zip / YAML file.
 *  - zip entries and folder paths must never escape the import root;
 *  - YAML alias bombs and zip bombs must hit a cap, not exhaust memory;
 *  - credentials kept in a v3 `_postman` sidecar must not survive a redacted
 *    export (the sidecar is stored in v2 terms the redactor understands, and
 *    raw unsupported items are scrubbed at import).
 */

const REQ = strToU8('$kind: http-request\nurl: https://example.com\n');

describe('Postman v3 container — path traversal', () => {
  it.each([
    '../x.request.yaml',
    'a/../../x.request.yaml',
    '/abs/x.request.yaml',
    'C:/win/x.request.yaml',
    'a\\..\\..\\x.request.yaml',
    'a/\0/x.request.yaml',
  ])('rejects %s in a zip', (path) => {
    expect(() => unzipPostmanV3Archive(zipSync({ [path]: REQ }))).toThrowError(
      PostmanV3ContainerError
    );
  });

  it('rejects an examples reference that walks out of the root', () => {
    expect(() =>
      readPostmanV3Container({
        'C/r.request.yaml': '$kind: http-request\nexamples: ../../../etc\n',
      })
    ).toThrowError(PostmanV3ContainerError);
  });
});

describe('Postman v3 container — bombs and caps', () => {
  it('a zip bomb is refused before it is fully inflated', () => {
    const zip = zipSync({ 'bomb.request.yaml': new Uint8Array(64 * 1024 * 1024) }, { level: 9 });
    expect(zip.byteLength).toBeLessThan(1024 * 1024);
    expect(() => unzipPostmanV3Archive(zip)).toThrowError(/too large/i);
  });

  it('too many zip entries is refused', () => {
    const files = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`r${i}.request.yaml`, REQ])
    );
    expect(() => unzipPostmanV3Archive(zipSync(files), { maxFiles: 20 })).toThrowError(
      /too many files/i
    );
  });

  it('a YAML billion-laughs document is refused', () => {
    const lines = ['l0: &l0 [lol, lol, lol, lol, lol, lol, lol, lol, lol]'];
    for (let i = 1; i < 9; i++) {
      lines.push(
        `l${i}: &l${i} [${Array(9)
          .fill(`*l${i - 1}`)
          .join(', ')}]`
      );
    }
    lines.push('$kind: collection', 'name: bomb', 'description: [*l8]');
    expect(() =>
      readPostmanV3Container({ '.resources/definition.yaml': lines.join('\n') })
    ).toThrowError(PostmanV3ContainerError);
  });

  it('a deeply nested single-object tree is refused', () => {
    let node: Record<string, unknown> = { $kind: 'http-request', name: 'leaf' };
    for (let i = 0; i < 200; i++) node = { $kind: 'collection', name: `f${i}`, items: [node] };
    expect(() => readPostmanV3Container({ ...node, $kind: 'collection' })).toThrowError(
      PostmanV3ContainerError
    );
  });
});

describe('Postman v3 sidecar — no plaintext credentials after redaction', () => {
  it('unsupported auth, multi-entry auth and raw unsupported items are redacted', () => {
    const { collection } = importPostmanCollection({
      $kind: 'collection',
      name: 'Leaky',
      auth: [
        {
          id: '1',
          name: 'a',
          type: 'hawk',
          credentials: [
            { key: 'authId', value: 'id' },
            { key: 'authKey', value: 'HAWK-SECRET-1' },
          ],
        },
        { id: '2', name: 'b', type: 'bearer', credentials: [{ key: 'token', value: 'BEARER-2' }] },
      ],
      items: [
        {
          $kind: 'llm-request',
          name: 'Model',
          url: 'https://llm.example.com',
          auth: { type: 'apikey', credentials: [{ key: 'value', value: 'LLM-KEY-3' }] },
        },
        {
          $kind: 'websocket-request',
          name: 'WS',
          url: 'wss://x',
          headers: [{ key: 'Authorization', value: 'Bearer WS-TOKEN-4' }],
        },
      ],
    });
    const redacted = JSON.stringify(redactCollectionSecrets(collection));
    for (const secret of ['HAWK-SECRET-1', 'BEARER-2', 'LLM-KEY-3', 'WS-TOKEN-4']) {
      expect(redacted).not.toContain(secret);
    }
  });
});

describe('Postman v3 review (#1200): prototype keys and archive input cap', () => {
  it('__proto__ / constructor keys in YAML never reach the logical tree', () => {
    const { tree } = readPostmanV3Container({
      '.resources/definition.yaml': '$kind: collection\nname: P\n__proto__:\n  polluted: true\n',
      'r.request.yaml':
        '$kind: http-request\nname: R\nconstructor:\n  x: 1\nheaders:\n  __proto__: evil\n',
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(tree)).toBe(Object.prototype);
    expect('polluted' in tree).toBe(false);
    const [item] = tree.items as Array<Record<string, unknown>>;
    expect(Object.hasOwn(item ?? {}, 'constructor')).toBe(false);
    expect(item?.headers).toEqual([]);
  });

  it('an oversized archive is refused before it is parsed', () => {
    const zip = zipSync({ 'r.request.yaml': REQ });
    expect(() => unzipPostmanV3Archive(zip, { maxArchiveBytes: 10 })).toThrowError(/too large/i);
  });

  it('inflated bytes are counted as they stream, not trusted from the header', () => {
    const zip = zipSync({ 'big.request.yaml': new Uint8Array(4096) }, { level: 9 });
    expect(() => unzipPostmanV3Archive(zip, { maxFileBytes: 1024 })).toThrowError(/too large/i);
  });
});
