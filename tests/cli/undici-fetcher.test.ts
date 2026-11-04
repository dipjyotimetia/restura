// @vitest-environment node
/**
 * Root-suite coverage of the CLI's undici-backed `Fetcher`
 * (`cli/src/runner/undiciFetcher.ts`), the third backend of the shared
 * protocol layer: method policy, body coercion (string / bytes / multipart),
 * header flattening, the buffered and streamed response views, and the run
 * dispatcher built from the TLS / proxy flags.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FetcherRequest } from '@shared/protocol/types';
import { Agent, ProxyAgent } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildDispatcher,
  createUndiciFetcher,
  escapeDispositionToken,
  tlsConnectOptions,
  undiciFetcher,
} from '../../cli/src/runner/undiciFetcher';

type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: string };

let server: Server;
let base: string;
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      });
      if (req.url === '/chunked') {
        res.writeHead(200, { 'x-multi': ['a', 'b'] });
        res.write('part1-');
        res.end('part2');
        return;
      }
      const payload = 'hello';
      res.writeHead(201, { 'content-type': 'text/plain', 'content-length': payload.length });
      res.end(payload);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

/** A full `FetcherRequest` from the fields a test cares about. */
const req = (fields: Partial<FetcherRequest> & { url: string }): FetcherRequest => ({
  method: 'GET',
  headers: {},
  body: undefined,
  signal: new AbortController().signal,
  ...fields,
});

const last = (): Seen => {
  const entry = seen.at(-1);
  if (!entry) throw new Error('no request reached the server');
  return entry;
};

describe('createUndiciFetcher — requests', () => {
  it('defaults to GET and buffers the response with its content length', async () => {
    const res = await undiciFetcher(req({ url: `${base}/plain` }));
    expect(res.status).toBe(201);
    expect(res.statusText).toBe('');
    expect(res.contentLengthHeader).toBe('5');
    expect(await res.text()).toBe('hello');
    expect(last().method).toBe('GET');
  });

  it('exposes the body as a web stream and reports no length for a chunked reply', async () => {
    const res = await undiciFetcher(req({ url: `${base}/chunked`, method: 'GET' }));
    expect(res.contentLengthHeader).toBeNull();
    expect((res.headers as Record<string, string | string[]>)['x-multi']).toEqual(['a', 'b']);
    const text = await new Response(res.body).text();
    expect(text).toBe('part1-part2');
  });

  it('sends a string body and an extension method verbatim', async () => {
    const res = await undiciFetcher(
      req({
        url: `${base}/s`,
        method: 'PURGE',
        headers: { 'x-a': '1' },
        body: 'text body',
      })
    );
    await res.text();
    expect(last()).toMatchObject({ method: 'PURGE', body: 'text body' });
    expect(last().headers['x-a']).toBe('1');
  });

  it('sends a byte body and flattens a Headers instance', async () => {
    const res = await undiciFetcher(
      req({
        url: `${base}/b`,
        method: 'POST',
        headers: new Headers({ 'X-From-Headers': 'yes' }),
        body: new TextEncoder().encode('bytes!'),
      })
    );
    await res.text();
    expect(last().body).toBe('bytes!');
    expect(last().headers['x-from-headers']).toBe('yes');
  });

  it('a null body sends none', async () => {
    const res = await undiciFetcher(
      req({ url: `${base}/n`, method: 'POST', body: null as unknown as BodyInit })
    );
    await res.text();
    expect(last().body).toBe('');
  });

  it('serialises FormData as multipart with escaped names and file defaults', async () => {
    const fd = new FormData();
    fd.append('plain', 'value');
    fd.append('bad"name\r\n', 'x');
    fd.append('typed', new File(['{"a":1}'], 'a.json', { type: 'application/json' }));
    fd.append('untyped', new Blob(['raw']));
    const res = await undiciFetcher(
      req({
        url: `${base}/form`,
        method: 'POST',
        headers: { 'content-type': 'will be replaced' },
        body: fd,
      })
    );
    await res.text();
    const { headers, body } = last();
    const boundary = /boundary=(\S+)/.exec(String(headers['content-type']))?.[1];
    expect(String(headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    expect(body).toContain(
      `--${boundary}\r\nContent-Disposition: form-data; name="plain"\r\n\r\nvalue\r\n`
    );
    expect(body).toContain('name="bad%22name%0D%0A"');
    expect(body).toContain(
      'name="typed"; filename="a.json"\r\nContent-Type: application/json\r\n\r\n{"a":1}\r\n'
    );
    // A Blob appended without a name gets FormData's default "blob" filename.
    expect(body).toMatch(
      /name="untyped"; filename="blob"\r\nContent-Type: application\/octet-stream\r\n\r\nraw\r\n/
    );
    expect(body.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  it('refuses body types the shared body builder never produces for the CLI', async () => {
    const before = seen.length;
    await expect(
      undiciFetcher(req({ url: `${base}/x`, method: 'POST', body: new URLSearchParams('a=1') }))
    ).rejects.toThrow(/only supports string, Uint8Array and FormData bodies/);
    expect(seen.length).toBe(before);
  });

  it.each(['TRACE', 'CONNECT', 'BAD METHOD'])(
    'refuses the %s method before any I/O',
    async (method) => {
      const before = seen.length;
      await expect(undiciFetcher(req({ url: `${base}/x`, method }))).rejects.toThrow(
        new RegExp(`Method ${method} not supported by CLI fetcher`)
      );
      expect(seen.length).toBe(before);
    }
  );

  it('sends through the dispatcher it was built with', async () => {
    const agent = new Agent();
    try {
      const res = await createUndiciFetcher(agent)(req({ url: `${base}/agent` }));
      expect(await res.text()).toBe('hello');
    } finally {
      await agent.close();
    }
  });
});

describe('escapeDispositionToken', () => {
  it('percent-encodes CR, LF and double quotes only', () => {
    expect(escapeDispositionToken('a"b\r\nc d')).toBe('a%22b%0D%0Ac d');
  });
});

describe('run TLS / proxy dispatcher', () => {
  it('maps only the TLS flags that are set', () => {
    expect(tlsConnectOptions()).toEqual({});
    expect(tlsConnectOptions({})).toEqual({});
    expect(
      tlsConnectOptions({
        rejectUnauthorized: false,
        ca: 'CA',
        cert: 'CERT',
        key: 'KEY',
        passphrase: 'pw',
      })
    ).toEqual({ rejectUnauthorized: false, ca: 'CA', cert: 'CERT', key: 'KEY', passphrase: 'pw' });
    expect(tlsConnectOptions({ rejectUnauthorized: true })).toEqual({ rejectUnauthorized: true });
  });

  it('uses the global dispatcher when no TLS flag or proxy is given', () => {
    expect(buildDispatcher()).toBeUndefined();
    expect(buildDispatcher({})).toBeUndefined();
  });

  it('builds an Agent for TLS flags and a ProxyAgent for --proxy (with or without TLS)', async () => {
    const tlsOnly = buildDispatcher({ ca: 'CA' });
    const proxyOnly = buildDispatcher(undefined, 'http://proxy.example.com:3128');
    const both = buildDispatcher({ rejectUnauthorized: false }, 'http://proxy.example.com:3128');
    try {
      expect(tlsOnly).toBeInstanceOf(Agent);
      expect(tlsOnly).not.toBeInstanceOf(ProxyAgent);
      expect(proxyOnly).toBeInstanceOf(ProxyAgent);
      expect(both).toBeInstanceOf(ProxyAgent);
    } finally {
      await Promise.all([tlsOnly, proxyOnly, both].map((d) => d?.close()));
    }
  });
});
