import { describe, it, expect } from 'vitest';
import { buildFormFields } from '@/features/http/lib/requestExecutor';
import { base64ByteLength, formatBytes } from '@/features/http/lib/fileEncoding';
import type { FormDataItem } from '@/types';

const item = (p: Partial<FormDataItem>): FormDataItem => ({
  id: p.id ?? 'x',
  key: p.key ?? '',
  value: p.value ?? '',
  enabled: p.enabled ?? true,
  type: p.type ?? 'text',
  ...(p.fileName !== undefined ? { fileName: p.fileName } : {}),
  ...(p.contentType !== undefined ? { contentType: p.contentType } : {}),
});

describe('buildFormFields (FormDataItem → proxy FormField)', () => {
  it('maps a text row to name/value only (no filename)', () => {
    const [field] = buildFormFields([item({ key: 'greeting', value: 'hi', type: 'text' })]);
    expect(field).toEqual({ name: 'greeting', value: 'hi' });
  });

  it('maps a file row with filename + contentType', () => {
    const [field] = buildFormFields([
      item({
        key: 'doc',
        value: 'YmFzZTY0',
        type: 'file',
        fileName: 'a.txt',
        contentType: 'text/plain',
      }),
    ]);
    expect(field).toEqual({
      name: 'doc',
      value: 'YmFzZTY0',
      filename: 'a.txt',
      contentType: 'text/plain',
    });
  });

  it('defaults filename + contentType for a file row missing them', () => {
    const [field] = buildFormFields([item({ key: 'f', value: 'AA==', type: 'file' })]);
    expect(field).toMatchObject({ filename: 'file', contentType: 'application/octet-stream' });
  });

  it('drops disabled and key-less rows', () => {
    expect(
      buildFormFields([
        item({ key: 'keep', value: '1' }),
        item({ key: 'skip', value: '2', enabled: false }),
        item({ key: '', value: '3' }),
      ])
    ).toEqual([{ name: 'keep', value: '1' }]);
  });

  it('returns [] for undefined', () => {
    expect(buildFormFields(undefined)).toEqual([]);
  });
});

describe('fileEncoding size helpers', () => {
  it('computes decoded byte length from base64', () => {
    // "hello" → "aGVsbG8=" (5 bytes)
    expect(base64ByteLength('aGVsbG8=')).toBe(5);
    expect(base64ByteLength('')).toBe(0);
  });

  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
