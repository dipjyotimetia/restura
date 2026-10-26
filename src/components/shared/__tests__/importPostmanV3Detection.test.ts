import { describe, expect, it } from 'vitest';
import {
  detectImportFormat,
  detectZipImportFormat,
  readPostmanFolderFiles,
} from '../import-dialog-data';

describe('Postman v3 detection in the import dialog (#1200)', () => {
  it('a single-file v3 logical tree (JSON or YAML) is Postman', () => {
    expect(detectImportFormat(JSON.stringify({ $kind: 'collection', name: 'C' }), 'c.json')).toBe(
      'postman'
    );
    expect(detectImportFormat('$kind: collection\nname: C\n', 'c.yaml')).toBe('postman');
  });

  it('a zip holding v3 files is Postman; anything else stays Bruno', () => {
    expect(detectZipImportFormat(['C/.resources/definition.yaml', 'C/Get.request.yaml'])).toBe(
      'postman'
    );
    expect(detectZipImportFormat(['coll/bruno.json', 'coll/Get.bru'])).toBe('bruno');
  });

  it('a picked folder becomes a relative-path map of its YAML / JSON files only', async () => {
    const file = (name: string, rel: string, text: string) =>
      Object.assign(new File([text], name), { webkitRelativePath: rel });
    const map = await readPostmanFolderFiles([
      file('Get.request.yaml', 'C/Get.request.yaml', '$kind: http-request\n'),
      file('logo.png', 'C/logo.png', 'binary'),
    ]);
    expect(map).toEqual({ 'C/Get.request.yaml': '$kind: http-request\n' });
  });

  it('an oversized folder file is refused before it is read', async () => {
    const big = Object.assign(new File(['x'], 'r.request.yaml'), {
      webkitRelativePath: 'C/r.request.yaml',
    });
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    await expect(readPostmanFolderFiles([big])).rejects.toThrow(/too large/);
  });
});
