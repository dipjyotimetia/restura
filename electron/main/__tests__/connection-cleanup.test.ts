// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { bindRendererCleanup } from '../ipc/connection-cleanup';

let nextId = 5000;
function fakeWebContents() {
  let destroyed = false;
  const emitter = Object.assign(new EventEmitter(), {
    id: nextId++,
    isDestroyed: () => destroyed,
  });
  return {
    wc: emitter as unknown as WebContents,
    emitter,
    destroy: () => {
      destroyed = true;
      emitter.emit('destroyed');
    },
  };
}

/** Committed main-frame cross-document navigation (reload included): (event, url, code, text). */
function commitNavigation(emitter: EventEmitter) {
  emitter.emit('did-navigate', {}, 'file:///app/dist/web/index.html', 200, 'OK');
}

describe('bindRendererCleanup', () => {
  it('runs teardown on a committed main-frame reload but not on hash-router or sub-frame navigation', () => {
    const { wc, emitter } = fakeWebContents();
    const teardown = vi.fn();
    bindRendererCleanup({}, wc, teardown);

    emitter.emit('did-navigate-in-page', {}, 'file:///app/index.html#/mcp', true);
    emitter.emit('did-frame-navigate', {}, 'about:blank', 200, 'OK', false);
    emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(teardown).not.toHaveBeenCalled();

    commitNavigation(emitter);
    expect(teardown).toHaveBeenCalledWith(wc.id);
  });

  it('a blocked navigation does not tear down', () => {
    const { wc, emitter } = fakeWebContents();
    const teardown = vi.fn();
    bindRendererCleanup({}, wc, teardown);
    // main.ts will-navigate guard cancels it (e.g. a link dropped on the window):
    // the navigation starts but never commits, so the page and its sessions live on.
    const event = { preventDefault: vi.fn() };
    emitter.emit('will-navigate', event, 'https://example.com/');
    event.preventDefault();
    emitter.emit('did-start-navigation', {
      url: 'https://example.com/',
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(teardown).not.toHaveBeenCalled();
  });

  it('stays bound across reloads (the next document reuses the webContents id)', () => {
    const { wc, emitter } = fakeWebContents();
    const key = {};
    const teardown = vi.fn();
    bindRendererCleanup(key, wc, teardown);
    commitNavigation(emitter);
    // The reloaded page reconnects: the dedupe keeps a single binding.
    bindRendererCleanup(key, wc, teardown);
    commitNavigation(emitter);
    expect(teardown).toHaveBeenCalledTimes(2);
  });

  it('runs teardown when the render process is gone', () => {
    const { wc, emitter } = fakeWebContents();
    const teardown = vi.fn();
    bindRendererCleanup({}, wc, teardown);
    emitter.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('shares one navigation listener across handlers and detaches it on destroy', () => {
    const { wc, emitter, destroy } = fakeWebContents();
    const a = vi.fn();
    const b = vi.fn();
    bindRendererCleanup({}, wc, a);
    bindRendererCleanup({}, wc, b);
    expect(emitter.listenerCount('did-navigate')).toBe(1);
    expect(emitter.listenerCount('render-process-gone')).toBe(1);

    commitNavigation(emitter);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    destroy();
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
    commitNavigation(emitter);
    expect(a).toHaveBeenCalledTimes(2);
  });

  it('keeps running the other handlers when one teardown throws', () => {
    const { wc, emitter } = fakeWebContents();
    const ok = vi.fn();
    bindRendererCleanup({}, wc, () => {
      throw new Error('boom');
    });
    bindRendererCleanup({}, wc, ok);
    commitNavigation(emitter);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('still works for webContents doubles that only implement once()', () => {
    const listeners: Array<() => void> = [];
    const wc = {
      id: nextId++,
      isDestroyed: () => false,
      once: (_event: string, cb: () => void) => listeners.push(cb),
    } as unknown as WebContents;
    const teardown = vi.fn();
    bindRendererCleanup({}, wc, teardown);
    for (const cb of listeners) cb();
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});
