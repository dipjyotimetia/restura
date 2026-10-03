import { describe, expect, it } from 'vitest';
import { detectImportFormat, detectRemoteFormat } from '../import-dialog-data';

describe('detectImportFormat', () => {
  it('detects by file name', () => {
    expect(detectImportFormat('{}', 'traffic.har')).toBe('har');
    expect(detectImportFormat('meta {}', 'Get.bru')).toBe('bruno');
    expect(detectImportFormat('GET https://x', 'api.http')).toBe('http');
  });

  it('detects by contents', () => {
    expect(detectImportFormat(JSON.stringify({ log: { entries: [] } }), 'capture.json')).toBe(
      'har'
    );
    expect(detectImportFormat('opencollection: 1.0.0\ninfo:\n  name: X\n', 'c.yaml')).toBe(
      'opencollection'
    );
    expect(detectImportFormat(JSON.stringify({ openapi: '3.1.0' }), 'spec.json')).toBe('openapi');
    expect(
      detectImportFormat(JSON.stringify({ info: { schema: 'postman' }, item: [] }), 'p.json')
    ).toBe('postman');
    expect(detectImportFormat(JSON.stringify({ _type: 'export', resources: [] }), 'i.json')).toBe(
      'insomnia'
    );
  });

  it('rejects unsupported files', () => {
    expect(() => detectImportFormat(JSON.stringify({ hello: 1 }), 'x.json')).toThrow(
      /not a supported/
    );
  });
});

describe('detectRemoteFormat', () => {
  it('still refuses HAR from a URL', () => {
    expect(() => detectRemoteFormat('{}', 'https://example.com/traffic.har')).toThrow(
      /not a supported/
    );
    expect(detectRemoteFormat(JSON.stringify({ openapi: '3.0.0' }), 'https://x.dev/spec')).toBe(
      'openapi'
    );
  });
});
