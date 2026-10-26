import { importPostmanV3Files } from '@shared/collections/postman';
import { render, screen } from '@testing-library/react';
import { strFromU8, unzipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Collection } from '@/types';

const h = vi.hoisted(() => ({
  electron: undefined as unknown,
  downloadBlob: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/shared/platform', async (orig) => ({
  ...(await orig<typeof import('@/lib/shared/platform')>()),
  getElectronAPI: () => h.electron,
}));
vi.mock('@/lib/shared/file-utils', async (orig) => ({
  ...(await orig<typeof import('@/lib/shared/file-utils')>()),
  downloadBlob: h.downloadBlob,
}));
vi.mock('sonner', () => ({ toast: h.toast }));

import { PostmanExportReportList } from '@/components/shared/PostmanExportReport';
import { exportToPostmanV3, savePostmanV3Export } from '../postmanV3Export';

const kv = (key: string, value: string) => ({ id: key, key, value, enabled: true });

function collection(withSse = true): Collection {
  const items: Collection['items'] = [
    {
      id: 'r',
      name: 'List orders',
      type: 'request',
      request: {
        id: 'r',
        name: 'List orders',
        type: 'http',
        method: 'GET',
        url: '{{baseUrl}}/orders',
        headers: [],
        params: [kv('page', '1')],
        body: { type: 'none' },
        auth: { type: 'none' },
      },
    },
  ];
  if (withSse) {
    items.push({
      id: 's',
      name: 'Stream',
      type: 'request',
      request: {
        id: 's',
        name: 'Stream',
        type: 'sse',
        url: 'https://shop.example.com/events',
        headers: [],
        params: [],
        auth: { type: 'none' },
      },
    });
  }
  return {
    id: 'c1',
    name: 'Shop API',
    variables: [kv('baseUrl', 'https://shop.example.com')],
    items: [{ id: 'f', name: 'Orders', type: 'folder', items }],
  };
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(
    await new Promise<ArrayBuffer>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(blob);
    })
  );
}

describe('Postman v3 export — renderer', () => {
  beforeEach(() => {
    h.electron = undefined;
    h.downloadBlob.mockReset();
    for (const fn of Object.values(h.toast)) fn.mockReset();
  });

  it('exportToPostmanV3 roots every entry under the collection folder', () => {
    const { root, entries } = exportToPostmanV3(collection());
    expect(root).toBe('Shop API');
    expect(entries.map((e) => e.relativePath).sort()).toEqual([
      'Shop API/.resources/definition.yaml',
      'Shop API/Orders/.resources/definition.yaml',
      'Shop API/Orders/List orders.request.yaml',
    ]);
  });

  it('web: downloads <name>.postman-v3.zip that re-imports, and shows the export report', async () => {
    expect(await savePostmanV3Export(collection())).toBe(true);
    expect(h.downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename, mime] = h.downloadBlob.mock.calls[0] as [Blob, string, string];
    expect(filename).toBe('Shop API.postman-v3.zip');
    expect(mime).toBe('application/zip');
    const files = Object.fromEntries(
      Object.entries(unzipSync(await blobBytes(blob))).map(([p, d]) => [p, strFromU8(d)])
    );
    const again = importPostmanV3Files(files).collection;
    expect(again.name).toBe('Shop API');
    expect(again.items[0]?.items?.map((i) => i.name)).toEqual(['List orders']);
    // SSE has no v3 kind: reported, not silently dropped.
    expect(h.toast.warning).toHaveBeenCalledWith(
      'Exported Shop API.postman-v3.zip — 1 item not exported as-is',
      expect.objectContaining({ description: expect.anything() })
    );
  });

  it('desktop: writes the folder under the picked directory via the directory-export IPC', async () => {
    const saveBrunoToDirectory = vi.fn().mockResolvedValue({ success: true });
    const selectDirectory = vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/tmp/out'] });
    h.electron = {
      collections: {
        selectDirectory,
        saveBrunoToDirectory,
        inspectExportTarget: vi.fn().mockResolvedValue({ exists: false, nonEmpty: false }),
      },
    };
    expect(await savePostmanV3Export(collection(false))).toBe(true);
    expect(h.downloadBlob).not.toHaveBeenCalled();
    const [entries, dir] = saveBrunoToDirectory.mock.calls[0] as [
      Array<{ relativePath: string }>,
      string,
    ];
    expect(dir).toBe('/tmp/out');
    expect(entries.every((e) => e.relativePath.startsWith('Shop API/'))).toBe(true);
    expect(h.toast.success).toHaveBeenCalledWith('Exported Postman v3 folder "Shop API"');
  });

  it('desktop: a cancelled picker writes nothing; a failed write shows an error', async () => {
    const saveBrunoToDirectory = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'denied' })
      .mockResolvedValueOnce({ success: false });
    const selectDirectory = vi.fn().mockResolvedValueOnce({ canceled: true });
    h.electron = {
      collections: {
        selectDirectory,
        saveBrunoToDirectory,
        inspectExportTarget: vi.fn().mockResolvedValue({ exists: false, nonEmpty: false }),
      },
    };
    expect(await savePostmanV3Export(collection())).toBe(false);
    expect(saveBrunoToDirectory).not.toHaveBeenCalled();
    selectDirectory.mockResolvedValue({ canceled: false, filePaths: ['/tmp/out'] });
    expect(await savePostmanV3Export(collection())).toBe(false);
    expect(h.toast.error).toHaveBeenCalledWith(
      'Postman v3 export failed: denied',
      expect.anything()
    );
    await savePostmanV3Export(collection());
    expect(h.toast.error).toHaveBeenLastCalledWith(
      'Postman v3 export failed: the folder could not be written',
      expect.anything()
    );
  });

  it('desktop: a rejected IPC call (validation / EACCES) is a visible error with the report', async () => {
    const saveBrunoToDirectory = vi.fn().mockRejectedValue(new Error('EACCES: permission denied'));
    const selectDirectory = vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/tmp/out'] });
    const inspectExportTarget = vi.fn().mockResolvedValue({ exists: false, nonEmpty: false });
    h.electron = { collections: { selectDirectory, saveBrunoToDirectory, inspectExportTarget } };
    expect(await savePostmanV3Export(collection())).toBe(false);
    expect(h.toast.error).toHaveBeenCalledWith(
      'Postman v3 export failed: EACCES: permission denied',
      expect.objectContaining({ description: expect.anything() })
    );
    selectDirectory.mockRejectedValueOnce('boom');
    expect(await savePostmanV3Export(collection(false))).toBe(false);
    expect(h.toast.error).toHaveBeenLastCalledWith('Postman v3 export failed: boom', {});
  });

  it('desktop: an existing non-empty folder needs confirmation; Replace clears the old layout', async () => {
    const saveBrunoToDirectory = vi.fn().mockResolvedValue({ success: true });
    const selectDirectory = vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/tmp/out'] });
    const inspectExportTarget = vi.fn().mockResolvedValue({ exists: true, nonEmpty: true });
    h.electron = { collections: { selectDirectory, saveBrunoToDirectory, inspectExportTarget } };
    const confirmReplace = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await savePostmanV3Export(collection(false), { confirmReplace })).toBe(false);
    expect(saveBrunoToDirectory).not.toHaveBeenCalled();
    expect(confirmReplace).toHaveBeenCalledWith('Shop API', '/tmp/out');
    expect(await savePostmanV3Export(collection(false), { confirmReplace })).toBe(true);
    expect(inspectExportTarget).toHaveBeenCalledWith('/tmp/out', 'Shop API');
    expect(saveBrunoToDirectory.mock.calls[0]?.[2]).toEqual({
      replace: { layout: 'postman-v3', subdir: 'Shop API' },
    });
  });

  it('web: a failed zip / download is a visible error', async () => {
    h.downloadBlob.mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(await savePostmanV3Export(collection(false))).toBe(false);
    expect(h.toast.error).toHaveBeenCalledWith('Postman v3 export failed: blocked', {});
  });

  it('the default Replace prompt is a native confirm', async () => {
    const saveBrunoToDirectory = vi.fn().mockResolvedValue({ success: true });
    const selectDirectory = vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/tmp/out'] });
    const inspectExportTarget = vi.fn().mockResolvedValue({ exists: true, nonEmpty: true });
    h.electron = { collections: { selectDirectory, saveBrunoToDirectory, inspectExportTarget } };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(await savePostmanV3Export(collection(false))).toBe(false);
    expect(confirm.mock.calls[0]?.[0]).toMatch(/"Shop API" already exists/);
    confirm.mockRestore();
  });

  it('the summary toast pluralises', async () => {
    const { showPostmanExportReport } = await import('@/components/shared/PostmanExportReport');
    const entry = {
      kind: 'dropped' as const,
      construct: 'sse-request' as const,
      itemName: 'a',
      detail: 'd',
    };
    showPostmanExportReport({ targetVersion: '3.0', entries: [entry, entry] }, 'Done');
    expect(h.toast.warning).toHaveBeenCalledWith(
      'Done — 2 items not exported as-is',
      expect.anything()
    );
  });

  it('the report list shows names + fixed notes and caps long reports', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      kind: 'dropped' as const,
      construct: 'sse-request' as const,
      itemName: `Req ${i}`,
      detail: 'Server-Sent Events requests have no Postman v3 kind; not exported',
    }));
    render(<PostmanExportReportList report={{ targetVersion: '3.0', entries }} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(9);
    expect(screen.getByText('… and 2 more')).toBeTruthy();
    expect(screen.getByText(/"Req 0"/)).toBeTruthy();
  });
});
