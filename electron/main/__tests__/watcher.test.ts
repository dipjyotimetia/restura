import { describe, it, expect, vi } from 'vitest';
import { debounce } from '../watcher-utils';

describe('debounce', () => {
  it('coalesces multiple calls within the window into one trailing invocation', async () => {
    const fn = vi.fn();
    const d = debounce(fn, 50);
    d(1);
    d(2);
    d(3);
    expect(fn).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 80));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
  });

  it('fires again after the window elapses', async () => {
    const fn = vi.fn();
    const d = debounce(fn, 30);
    d('first');
    await new Promise((r) => setTimeout(r, 50));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith('first');
    d('second');
    await new Promise((r) => setTimeout(r, 50));
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('second');
  });
});
