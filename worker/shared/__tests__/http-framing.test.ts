// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  encodeRequest,
  frameBody,
  isBodylessStatus,
  parseResponseHead,
  parseStatusCode,
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
    expect(wire).toBe('POST /p?q=1 HTTP/1.1\r\nHost: target.example:8443\r\nX-A: 1\r\n\r\nbody');
    expect(wire.match(/^host:/gim)).toHaveLength(1);
  });

  it('encodeRequest emits only the head for an absent or empty body', () => {
    const head = 'GET http://t.example/ HTTP/1.1\r\nHost: t.example\r\n\r\n';
    expect(text(encodeRequest('GET', 'http://t.example/', 't.example', {}))).toBe(head);
    expect(text(encodeRequest('GET', 'http://t.example/', 't.example', {}, new Uint8Array()))).toBe(
      head
    );
  });

  it('toResponse gives 101/204/205/304 a null body and keeps repeated headers', async () => {
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
});
