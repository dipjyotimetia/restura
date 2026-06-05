// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { bindRendererCleanup, disposeByOwner } from '../connection-cleanup';
import { fakeWebContents } from './helpers/electron-mock';

type Entry = { webContentsId: number; closed?: boolean };

describe('bindRendererCleanup', () => {
  it('tears down immediately when the webContents is already destroyed', () => {
    const wc = fakeWebContents(7);
    wc.isDestroyed.mockReturnValue(true);
    const teardown = vi.fn();

    bindRendererCleanup({}, wc as never, teardown);

    expect(teardown).toHaveBeenCalledWith(7);
    expect(wc.once).not.toHaveBeenCalled();
  });

  it('registers a one-shot destroyed listener and runs teardown on destroy', () => {
    const wc = fakeWebContents(3);
    const teardown = vi.fn();

    bindRendererCleanup({}, wc as never, teardown);
    expect(wc.once).toHaveBeenCalledWith('destroyed', expect.any(Function));
    expect(teardown).not.toHaveBeenCalled();

    // Simulate the renderer being destroyed.
    const destroyedCb = wc.once.mock.calls[0]![1] as () => void;
    destroyedCb();
    expect(teardown).toHaveBeenCalledWith(3);
  });

  it('dedupes per handler key so reconnects do not stack listeners', () => {
    const key = {};
    const wc1 = fakeWebContents(5);
    const wc2 = fakeWebContents(5); // same id, second connect from same renderer

    bindRendererCleanup(key, wc1 as never, vi.fn());
    bindRendererCleanup(key, wc2 as never, vi.fn());

    expect(wc1.once).toHaveBeenCalledTimes(1);
    expect(wc2.once).not.toHaveBeenCalled();
  });

  it('binds again after the previous listener fired (id removed from the set)', () => {
    const key = {};
    const wc = fakeWebContents(9);

    bindRendererCleanup(key, wc as never, vi.fn());
    (wc.once.mock.calls[0]![1] as () => void)(); // fire destroyed → removes id

    const wc2 = fakeWebContents(9);
    bindRendererCleanup(key, wc2 as never, vi.fn());
    expect(wc2.once).toHaveBeenCalledTimes(1);
  });

  it('tracks different handler keys independently', () => {
    const wcA = fakeWebContents(1);
    const wcB = fakeWebContents(1);
    bindRendererCleanup({}, wcA as never, vi.fn());
    bindRendererCleanup({}, wcB as never, vi.fn());
    expect(wcA.once).toHaveBeenCalledTimes(1);
    expect(wcB.once).toHaveBeenCalledTimes(1);
  });

  it('swallows teardown errors thrown from the destroyed listener', () => {
    const wc = fakeWebContents(2);
    bindRendererCleanup({}, wc as never, () => {
      throw new Error('boom');
    });
    const cb = wc.once.mock.calls[0]![1] as () => void;
    expect(() => cb()).not.toThrow();
  });
});

describe('disposeByOwner', () => {
  it('disposes and deletes only entries owned by the dead webContents id', () => {
    const map = new Map<string, Entry>([
      ['a', { webContentsId: 1 }],
      ['b', { webContentsId: 2 }],
      ['c', { webContentsId: 1 }],
    ]);
    const dispose = vi.fn((e: Entry) => {
      e.closed = true;
    });

    disposeByOwner(map, 1, dispose);

    expect(dispose).toHaveBeenCalledTimes(2);
    expect(map.has('a')).toBe(false);
    expect(map.has('c')).toBe(false);
    expect(map.has('b')).toBe(true);
  });

  it('swallows dispose errors but still deletes the entry', () => {
    const map = new Map<string, Entry>([['a', { webContentsId: 1 }]]);
    disposeByOwner(map, 1, () => {
      throw new Error('dispose failed');
    });
    expect(map.has('a')).toBe(false);
  });

  it('is a no-op when no entry matches', () => {
    const map = new Map<string, Entry>([['a', { webContentsId: 2 }]]);
    const dispose = vi.fn();
    disposeByOwner(map, 99, dispose);
    expect(dispose).not.toHaveBeenCalled();
    expect(map.size).toBe(1);
  });
});
