import { createLogger } from '@shared/runtime/logger';
import type { WebContents } from 'electron';

const log = createLogger('connection-cleanup');

// Per-handler dedupe of webContents ids that already have a `destroyed`
// listener — without it, every reconnect from the same renderer stacks a
// new listener (Node warns at 10, but the real cost is N teardowns per close).
const boundByHandler = new WeakMap<object, Set<number>>();

/**
 * Per-webContents fan-out for "the renderer document went away but the
 * webContents lives on" (View → Reload, a renderer crash, a committed full
 * navigation).
 * One listener pair per webContents however many handlers bind, so a dozen
 * protocol registries don't trip Node's max-listener warning.
 */
const resetHooks = new WeakMap<WebContents, Set<() => void>>();

function addResetHook(webContents: WebContents, hook: () => void): () => void {
  // Test doubles (and any non-EventEmitter shape) only support `once('destroyed')`.
  if (typeof webContents.on !== 'function') return () => undefined;
  let hooks = resetHooks.get(webContents);
  if (!hooks) {
    const created = new Set<() => void>();
    hooks = created;
    resetHooks.set(webContents, created);
    const runAll = () => {
      for (const run of [...created]) run();
    };
    // `did-navigate` = a COMMITTED main-frame cross-document navigation
    // (reload included). Same-document (hash router / pushState) navigations
    // emit `did-navigate-in-page` and sub-frames `did-frame-navigate`, so they
    // never get here. Not `did-start-navigation`: a navigation the main.ts
    // will-navigate guard cancels (e.g. a link dropped on the window) starts
    // but never commits, and must not tear down the page's live sessions.
    webContents.on('did-navigate', runAll);
    webContents.on('render-process-gone', runAll);
  }
  const set = hooks;
  set.add(hook);
  return () => {
    set.delete(hook);
  };
}

/**
 * Idempotently registers renderer cleanup for `webContents`:
 * `teardown(webContentsId)` runs when the webContents is destroyed AND
 * whenever its document is replaced while the webContents survives (reload,
 * committed main-frame cross-document navigation, renderer crash) — otherwise sessions
 * and child processes would outlive the page that owns them with nothing left
 * to close them. Same-document (hash-router) navigations never trigger it.
 * `handlerKey` dedupes across reconnects (the handler's `activeConnections`
 * Map works fine as the key). `teardown` may run more than once per
 * webContents and must be idempotent.
 */
export function bindRendererCleanup(
  handlerKey: object,
  webContents: WebContents,
  teardown: (webContentsId: number) => void
): void {
  if (webContents.isDestroyed()) {
    teardown(webContents.id);
    return;
  }
  let bound = boundByHandler.get(handlerKey);
  if (!bound) {
    bound = new Set<number>();
    boundByHandler.set(handlerKey, bound);
  }
  const id = webContents.id;
  if (bound.has(id)) return;
  bound.add(id);
  const run = (reason: string) => {
    try {
      teardown(id);
    } catch (err) {
      log.error('teardown failed', {
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  // Stays bound across reloads: the next document reuses this webContents id.
  const removeResetHook = addResetHook(webContents, () => run('document-reset'));
  webContents.once('destroyed', () => {
    bound.delete(id);
    removeResetHook();
    run('destroyed');
  });
}

/**
 * Walk a connection map, run `dispose` on every entry owned by `deadId`,
 * and delete it. Centralises the "match webContentsId → cleanup → delete"
 * loop that every long-lived-transport handler needs.
 */
export function disposeByOwner<V extends { webContentsId: number }>(
  map: Map<string, V>,
  deadId: number,
  dispose: (entry: V) => void
): void {
  for (const [id, entry] of map) {
    if (entry.webContentsId !== deadId) continue;
    try {
      dispose(entry);
    } catch {
      /* swallow — best-effort cleanup */
    }
    map.delete(id);
  }
}
