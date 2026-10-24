// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { bindRendererCleanup, isDocumentReplacingNavigation } from '../ipc/connection-cleanup';

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

const crossDocument = { isMainFrame: true, isSameDocument: false };

describe('bindRendererCleanup', () => {
  it('runs teardown on a main-frame reload but not on same-document (hash router) navigation', () => {
    const { wc, emitter } = fakeWebContents();
    const teardown = vi.fn();
    bindRendererCleanup({}, wc, teardown);

    emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    emitter.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    expect(teardown).not.toHaveBeenCalled();

    emitter.emit('did-start-navigation', crossDocument);
    expect(teardown).toHaveBeenCalledWith(wc.id);
  });

  it('stays bound across reloads (the next document reuses the webContents id)', () => {
    const { wc, emitter } = fakeWebContents();
    const key = {};
    const teardown = vi.fn();
    bindRendererCleanup(key, wc, teardown);
    emitter.emit('did-start-navigation', crossDocument);
    // The reloaded page reconnects: the dedupe keeps a single binding.
    bindRendererCleanup(key, wc, teardown);
    emitter.emit('did-start-navigation', crossDocument);
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
    expect(emitter.listenerCount('did-start-navigation')).toBe(1);
    expect(emitter.listenerCount('render-process-gone')).toBe(1);

    emitter.emit('did-start-navigation', crossDocument);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    destroy();
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
    emitter.emit('did-start-navigation', crossDocument);
    expect(a).toHaveBeenCalledTimes(2);
  });

  it('keeps running the other handlers when one teardown throws', () => {
    const { wc, emitter } = fakeWebContents();
    const ok = vi.fn();
    bindRendererCleanup({}, wc, () => {
      throw new Error('boom');
    });
    bindRendererCleanup({}, wc, ok);
    emitter.emit('did-start-navigation', crossDocument);
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

describe('isDocumentReplacingNavigation', () => {
  it('reads the Electron details object', () => {
    expect(isDocumentReplacingNavigation([crossDocument])).toBe(true);
    expect(isDocumentReplacingNavigation([{ isMainFrame: true, isSameDocument: true }])).toBe(
      false
    );
    expect(isDocumentReplacingNavigation([{ isMainFrame: false, isSameDocument: false }])).toBe(
      false
    );
  });

  it('reads the deprecated positional form (event, url, isInPlace, isMainFrame)', () => {
    expect(isDocumentReplacingNavigation([{}, 'file:///x', false, true])).toBe(true);
    expect(isDocumentReplacingNavigation([{}, 'file:///x#/a', true, true])).toBe(false);
    expect(isDocumentReplacingNavigation([{}, 'file:///x', false, false])).toBe(false);
  });

  it('keeps state for unknown shapes', () => {
    expect(isDocumentReplacingNavigation([])).toBe(false);
    expect(isDocumentReplacingNavigation(['x'])).toBe(false);
  });
});
