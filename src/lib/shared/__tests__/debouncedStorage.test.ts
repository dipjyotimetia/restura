import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PersistStorage, StorageValue } from 'zustand/middleware';
import { debouncedStorage } from '../debouncedStorage';

function makeInner() {
  const setItem = vi.fn(async () => undefined);
  const removeItem = vi.fn(async () => undefined);
  const getItem = vi.fn(async () => null);
  const inner: PersistStorage<unknown> = { setItem, removeItem, getItem };
  return { inner, setItem, removeItem, getItem };
}

const val = (n: number): StorageValue<unknown> => ({ state: { n }, version: 0 });

describe('debouncedStorage', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces rapid setItem calls into a single trailing write', () => {
    const { inner, setItem } = makeInner();
    const s = debouncedStorage(inner, 400, 2000);
    s.setItem('k', val(1));
    s.setItem('k', val(2));
    s.setItem('k', val(3));
    expect(setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledWith('k', val(3)); // last write wins
  });

  it('checkpoints by maxWait even under a continuous stream of writes', () => {
    const { inner, setItem } = makeInner();
    const s = debouncedStorage(inner, 400, 1000);
    // Write every 300ms — never idle long enough for the 400ms trailing timer,
    // but maxWait (1000ms) forces a flush.
    for (let i = 0; i < 5; i++) {
      s.setItem('k', val(i));
      vi.advanceTimersByTime(300);
    }
    expect(setItem).toHaveBeenCalled();
  });

  it('passes getItem through to the inner storage', async () => {
    const { inner, getItem } = makeInner();
    const s = debouncedStorage(inner, 400, 2000);
    await s.getItem('k');
    expect(getItem).toHaveBeenCalledWith('k');
  });

  it('removeItem cancels a pending write and forwards to inner', () => {
    const { inner, setItem, removeItem } = makeInner();
    const s = debouncedStorage(inner, 400, 2000);
    s.setItem('k', val(1));
    s.removeItem('k');
    vi.advanceTimersByTime(400);
    expect(setItem).not.toHaveBeenCalled(); // pending write dropped
    expect(removeItem).toHaveBeenCalledWith('k');
  });

  it('flushes the pending write on pagehide', () => {
    const { inner, setItem } = makeInner();
    const s = debouncedStorage(inner, 400, 2000);
    s.setItem('k', val(7));
    window.dispatchEvent(new Event('pagehide'));
    expect(setItem).toHaveBeenCalledWith('k', val(7));
  });
});
