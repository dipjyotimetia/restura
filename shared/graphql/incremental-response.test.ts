import { describe, expect, it } from 'vitest';
import { incrementalPartsNotice, mergeIncrementalGraphQLResponse } from './incremental-response';

const CONTENT_TYPE = 'multipart/mixed; boundary="-"';
const part = (json: string) =>
  `\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${
    new TextEncoder().encode(json).byteLength
  }\r\n\r\n${json}\r\n---`;

describe('mergeIncrementalGraphQLResponse notice', () => {
  it('says the result is complete when the stream signalled hasNext:false', () => {
    const body =
      '\r\n---' +
      part('{"data":{"hello":"world"},"hasNext":true}') +
      part('{"incremental":[{"data":{"slow":"x"},"path":[]}],"hasNext":false}') +
      '\r\n-----\r\n';
    const out = mergeIncrementalGraphQLResponse({
      headers: { 'content-type': CONTENT_TYPE },
      body,
    });
    expect(out.bodyNotice).toBe(incrementalPartsNotice(2, true));
    expect(out.bodyNotice).toMatch(/into one JSON result/);
  });

  it('flags the result as incomplete when the stream ended while hasNext was still true', () => {
    const body = `\r\n---${part('{"data":{"hello":"world"},"hasNext":true}')}\r\n-----\r\n`;
    const out = mergeIncrementalGraphQLResponse({
      headers: { 'content-type': CONTENT_TYPE },
      body,
    });
    expect(JSON.parse(out.body)).toEqual({ data: { hello: 'world' } });
    expect(out.bodyNotice).not.toMatch(/into one JSON result/);
    expect(out.bodyNotice).not.toMatch(/on the way/);
    expect(out.bodyNotice).toMatch(/incomplete/i);
  });
});
