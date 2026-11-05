// @vitest-environment node
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  userData: '/tmp/x',
  home: '/tmp/restura-home-none',
  handle: vi.fn(),
  picked: [] as string[],
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => (name === 'userData' ? h.userData : h.home)),
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: h.picked })),
  },
  ipcMain: { handle: h.handle },
  shell: {},
}));

import { IPC } from '../../shared/channels';
import { registerCollectionManagerIPC } from '../storage/collection-manager';
import { isPathRealSafe, resetGrantedCollectionRootsForTests } from '../storage/file-operations';

const trustedEvent = { senderFrame: { url: 'file:///app/dist/web/index.html', parent: null } };

describe('collection:select-directory grants the picked folder', () => {
  let base: string;

  beforeEach(async () => {
    base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'select-dir-')));
    h.userData = path.join(base, 'ud');
    await fsp.mkdir(h.userData);
    resetGrantedCollectionRootsForTests();
    h.handle.mockClear();
    registerCollectionManagerIPC(() => ({}) as never);
  });
  afterEach(async () => {
    resetGrantedCollectionRootsForTests();
    await fsp.rm(base, { recursive: true, force: true });
  });

  it('makes a folder outside home/documents/userData loadable only after the dialog', async () => {
    const picked = path.join(base, 'elsewhere', 'api');
    await fsp.mkdir(picked, { recursive: true });
    h.picked = [picked];
    expect(await isPathRealSafe(picked)).toBe(false);

    const call = h.handle.mock.calls.find(([c]) => c === IPC.collection.selectDirectory);
    const handler = call?.[1] as (e: unknown, p: unknown) => Promise<{ filePaths?: string[] }>;
    const result = await handler(trustedEvent, undefined);

    expect(result.filePaths).toEqual([picked]);
    expect(await isPathRealSafe(picked)).toBe(true);
  });
});
