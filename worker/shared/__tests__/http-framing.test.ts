// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  assertCompleteAtEof,
  encodeRequest,
  findFinalHead,
  frameBody,
  isBodyComplete,
  isBodylessStatus,
  parseResponseHead,
  parseStatusCode,
  sliceBody,
  toRecord,
  toResponse,
} from '../http-framing';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('http-framing', () => {
  it('toRecord normalises Headers, tuple arrays and records into a fresh object', () => {
    expect(toRecord(new Headers({ 'X-A': '1' }))).toEqual({ 'x-a': '1' });
    expect(toRecord([['X-B', '2']])).toEqual({ 'X-B': '2' });
    const input = { 'X-C': '3' };
    const out = toRecord(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(toRecord(undefined)).toEqual({});
  });

  it('parseStatusCode reads only the second token and maps garbage to 502', () => {
    expect(parseStatusCode('HTTP/1.1 204 No Content')).toBe(204);
    expect(parseStatusCode('HTTP/1.1 502 Backend 200 unavailable')).toBe(502);
    expect(parseStatusCode('HTTP/1.1')).toBe(502);
    expect(parseStatusCode('HTTP/1.1 abc')).toBe(502);
  });

  it('isBodylessStatus covers 1xx, 204 and 304 only', () => {
    expect([100, 101, 199, 204, 304].every(isBodylessStatus)).toBe(true);
    expect([200, 205, 302, 404].some(isBodylessStatus)).toBe(false);
  });

  it('parseResponseHead lower-cases names, keeps duplicates in order and skips colon-less lines', () => {
    const head = parseResponseHead(
      'HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nbogus line\r\nset-cookie: b=2\r\nX-Url: http://h:1'
    );
    expect(head.statusLine).toBe('HTTP/1.1 200 OK');
    expect(head.headerList).toEqual([
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
      ['x-url', 'http://h:1'],
    ]);
    expect(head.headers).toEqual({ 'set-cookie': 'b=2', 'x-url': 'http://h:1' });
  });

  it('frameBody UTF-8 encodes strings and replaces Content-Length in any case', async () => {
    const headers: Record<string, string> = { 'content-length': '999' };
    const bytes = await frameBody('héllo', headers);
    expect(bytes?.byteLength).toBe(6);
    expect(headers).toEqual({ 'Content-Length': '6' });
  });

  it('frameBody passes byte views through and leaves headers alone for no body', async () => {
    const view = new Uint8Array([1, 2, 3]);
    const headers: Record<string, string> = {};
    expect(await frameBody(view, headers)).toBe(view);
    const none: Record<string, string> = {};
    expect(await frameBody(undefined, none)).toBeUndefined();
    expect(none).toEqual({});
  });

  it('frameBody serialises FormData with its multipart Content-Type unless the caller set one', async () => {
    const form = new FormData();
    form.append('a', '1');
    const headers: Record<string, string> = {};
    const bytes = await frameBody(form, headers);
    expect(headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(headers['Content-Length']).toBe(String(bytes?.byteLength));

    const preset: Record<string, string> = { 'content-type': 'multipart/x-custom' };
    await frameBody(form, preset);
    expect(preset['Content-Type']).toBeUndefined();
    expect(preset['content-type']).toBe('multipart/x-custom');
  });

  it('encodeRequest writes Host from the authority once and skips caller Host in any case', () => {
    const wire = text(
      encodeRequest(
        'POST',
        '/p?q=1',
        'target.example:8443',
        { HOST: 'stale.example', host: 'other', 'X-A': '1' },
        new TextEncoder().encode('body')
      )
    );
    expect(wire).toBe(
      'POST /p?q=1 HTTP/1.1\r\nHost: target.example:8443\r\nConnection: close\r\nX-A: 1\r\n\r\nbody'
    );
    expect(wire.match(/^host:/gim)).toHaveLength(1);
  });

  it('encodeRequest always asks the upstream to close after the single response', () => {
    const text = new TextDecoder().decode(
      encodeRequest('GET', '/', 'h.example', { Connection: 'keep-alive', 'X-A': '1' })
    );
    const lines = text.split('\r\n').filter((l) => /^connection:/i.test(l));
    expect(lines).toEqual(['Connection: close']);
  });

  it('encodeRequest emits only the head for an absent or empty body', () => {
    const head = 'GET http://t.example/ HTTP/1.1\r\nHost: t.example\r\nConnection: close\r\n\r\n';
    expect(text(encodeRequest('GET', 'http://t.example/', 't.example', {}))).toBe(head);
    expect(text(encodeRequest('GET', 'http://t.example/', 't.example', {}, new Uint8Array()))).toBe(
      head
    );
  });

  it('toResponse gives 204/205/304 a null body and keeps repeated headers', async () => {
    for (const status of [204, 205, 304]) {
      const res = toResponse(`HTTP/1.1 ${status} X`, [], new Uint8Array([1]));
      expect(res.status).toBe(status);
      expect(res.body).toBeNull();
    }
    const res = toResponse(
      'HTTP/1.1 200 OK',
      [
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
      ],
      new TextEncoder().encode('ok')
    );
    expect(await res.text()).toBe('ok');
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });

  it('encodeRequest rejects header names and values that would inject lines onto the socket', () => {
    const cases: Array<Record<string, string>> = [
      { 'X-A': 'v\r\nX-Injected: 1' },
      { 'X-A': 'v\nX-Injected: 1' },
      { 'X-A\r\nX-Injected': '1' },
      { 'Bad Name': '1' },
      { 'X-A': 'v\u0000' },
      { 'X-A': 'v€' },
    ];
    for (const headers of cases) {
      expect(() => encodeRequest('GET', '/', 'h.example', headers)).toThrow(
        /Invalid request header/
      );
    }
  });

  it('encodeRequest writes header octets as-is (Latin-1), like fetch, and trims edge whitespace', () => {
    const wire = encodeRequest('GET', '/', 'h.example', { 'X-Name': ' café ' });
    const line = 'X-Name: café\r\n';
    const at = text(wire).indexOf('X-Name:');
    expect(Array.from(wire.subarray(at, at + line.length))).toEqual(
      Array.from(line, (c) => c.charCodeAt(0))
    );
  });
});

describe('response head on raw bytes (both twins)', () => {
  const bytes = (...parts: Array<string | number[]>) =>
    Uint8Array.from(
      parts.flatMap((p) => (typeof p === 'string' ? Array.from(p, (c) => c.charCodeAt(0)) : p))
    );

  it('returns null until the head is complete', () => {
    expect(findFinalHead(bytes('HTTP/1.1 200 OK\r\nA: 1\r\n'))).toBeNull();
  });

  it('decodes the head as Latin-1 and keeps the body offset in bytes', () => {
    // "café" as UTF-8 (2 bytes for é) and a 0x80 obs-text octet.
    const all = bytes(
      'HTTP/1.1 200 OK\r\nX-Name: caf',
      [0xc3, 0xa9],
      '\r\nX-Raw: ',
      [0x80],
      '\r\nContent-Length: 2\r\n\r\nok'
    );
    const head = findFinalHead(all);
    expect(head?.headers['x-name']).toBe('cafÃ©');
    expect(head?.headers['x-raw']).toBe('\u0080');
    expect(head && text(sliceBody(all, head))).toBe('ok');
    expect(
      () => head && toResponse(head.statusLine, head.headerList, sliceBody(all, head))
    ).not.toThrow();
  });

  it('skips 1xx interim heads and returns the final one', () => {
    const all = bytes(
      'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nLink: </a.css>\r\n\r\n',
      'HTTP/1.1 201 Created\r\nContent-Length: 1\r\n\r\nx'
    );
    const head = findFinalHead(all);
    expect(head?.statusLine).toBe('HTTP/1.1 201 Created');
    expect(head?.headers.link).toBeUndefined();
    expect(head && text(sliceBody(all, head))).toBe('x');
    expect(findFinalHead(bytes('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200'))).toBeNull();
  });

  it('fails on 101 — the request never asked to switch protocols', () => {
    expect(() => findFinalHead(bytes('HTTP/1.1 101 Switching Protocols\r\n\r\n'))).toThrow(/101/);
  });

  it('fails when no final head arrives within the head size cap', () => {
    expect(() => findFinalHead(bytes(`HTTP/1.1 200 OK\r\nX: ${'a'.repeat(70_000)}`))).toThrow(
      /head too large/
    );
  });

  it('knows when a body is complete before EOF', () => {
    const all = bytes('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\no');
    const head = findFinalHead(all);
    if (!head) throw new Error('head expected');
    expect(isBodyComplete(head, all.byteLength)).toBe(false);
    expect(isBodyComplete(head, all.byteLength + 1)).toBe(true);
    const bodyless = findFinalHead(bytes('HTTP/1.1 304 Not Modified\r\n\r\n'));
    expect(bodyless && isBodyComplete(bodyless, 0)).toBe(true);
  });

  it('fails at EOF on abort, a missing head or a short Content-Length body', () => {
    const live = new AbortController().signal;
    const all = bytes('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nab');
    const head = findFinalHead(all);
    expect(() => assertCompleteAtEof(head, all.byteLength, live)).toThrow(/2 of 5 body bytes/);
    expect(() => assertCompleteAtEof(null, 0, live)).toThrow(/before response headers/);
    const aborted = AbortSignal.abort();
    const full = bytes('HTTP/1.1 200 OK\r\n\r\nbody');
    expect(() => assertCompleteAtEof(findFinalHead(full), full.byteLength, aborted)).toThrow(
      /Aborted/
    );
    expect(() => assertCompleteAtEof(findFinalHead(full), full.byteLength, live)).not.toThrow();
  });
});
