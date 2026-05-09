import { describe, it, expect } from 'vitest';
import { buildRequestBody } from './body-builder';

describe('buildRequestBody', () => {
  it('returns empty body for type "none"', () => {
    expect(buildRequestBody({ bodyType: 'none' })).toEqual({ body: undefined, contentType: undefined });
  });

  it('returns empty body when bodyType is undefined', () => {
    expect(buildRequestBody({})).toEqual({ body: undefined, contentType: undefined });
  });

  it('returns JSON body with content-type', () => {
    const r = buildRequestBody({ bodyType: 'json', data: '{"a":1}' });
    expect(r.body).toBe('{"a":1}');
    expect(r.contentType).toBe('application/json');
  });

  it('returns text body', () => {
    const r = buildRequestBody({ bodyType: 'text', data: 'hello' });
    expect(r.body).toBe('hello');
    expect(r.contentType).toBe('text/plain');
  });

  it('returns raw body without suggesting a Content-Type', () => {
    const r = buildRequestBody({ bodyType: 'raw', data: 'hello' });
    expect(r.body).toBe('hello');
    expect(r.contentType).toBeUndefined();
  });

  it('builds form-urlencoded from formData', () => {
    const r = buildRequestBody({
      bodyType: 'form-urlencoded',
      formData: [
        { name: 'a', value: '1' },
        { name: 'b', value: 'two & three' },
      ],
    });
    expect(r.contentType).toBe('application/x-www-form-urlencoded');
    expect(r.body).toBe('a=1&b=two+%26+three');
  });

  it('falls back to raw data for form-urlencoded when no formData provided', () => {
    const r = buildRequestBody({ bodyType: 'form-urlencoded', data: 'a=1&b=2' });
    expect(r.body).toBe('a=1&b=2');
    expect(r.contentType).toBe('application/x-www-form-urlencoded');
  });

  it('builds multipart form-data with file fields', () => {
    const r = buildRequestBody({
      bodyType: 'form-data',
      formData: [
        { name: 'name', value: 'Alice' },
        { name: 'avatar', value: btoa('PNGDATA'), filename: 'a.png', contentType: 'image/png' },
      ],
    });
    expect(r.body).toBeInstanceOf(FormData);
    expect(r.contentType).toBeUndefined(); // FormData sets its own boundary
    const fd = r.body as FormData;
    expect(fd.get('name')).toBe('Alice');
    const file = fd.get('avatar') as unknown as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe('image/png');
  });

  it('builds multipart form-data with default content-type when none specified', () => {
    const r = buildRequestBody({
      bodyType: 'form-data',
      formData: [
        { name: 'doc', value: btoa('hello'), filename: 'doc.bin' },
      ],
    });
    const fd = r.body as FormData;
    const file = fd.get('doc') as unknown as File;
    expect(file.type).toBe('application/octet-stream');
  });

  it('decodes base64 binary body', () => {
    const r = buildRequestBody({ bodyType: 'binary', data: btoa('hi') });
    expect(r.contentType).toBe('application/octet-stream');
    expect(r.body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(r.body as Uint8Array)).toBe('hi');
  });

  it('returns empty body for binary type without data', () => {
    expect(buildRequestBody({ bodyType: 'binary' })).toEqual({ body: undefined, contentType: undefined });
  });
});
