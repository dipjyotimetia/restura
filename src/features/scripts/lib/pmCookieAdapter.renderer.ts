/**
 * Renderer-side implementation of the `pm.cookies` host bridge —
 * wraps `useCookieStore` (Zustand) so script-side reads/writes flow
 * through the same RFC 6265 jar a top-level send uses.
 *
 * Kept out of `pmCookieAdapter.ts` so the type-only file can be
 * type-checked by the CLI workspace without dragging `useCookieStore`
 * (and its transitive `platform.ts` / `dexie-storage.ts` imports) into
 * the CLI compile graph. The CLI either omits cookies entirely or
 * supplies its own file-backed jar.
 */
import { useCookieStore } from '@/features/http/store/useCookieStore';
import type { PmCookieAdapter, PmCookieRecord } from './pmCookieAdapter';

function toPmRecord(
  c: ReturnType<typeof useCookieStore.getState>['cookies'][number]
): PmCookieRecord {
  return {
    name: c.key,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    ...(c.expires ? { expires: c.expires } : {}),
  };
}

function inferDomainPath(url: string): { domain: string; path: string; secure: boolean } {
  try {
    const u = new URL(url);
    return { domain: u.hostname, path: u.pathname || '/', secure: u.protocol === 'https:' };
  } catch {
    return { domain: '', path: '/', secure: false };
  }
}

/**
 * Build a cookie adapter scoped to the supplied request URL. The
 * `forCurrentUrl()` method is what `pm.cookies.get(name)` / `pm.cookies.has(name)`
 * read; jar operations take an explicit URL.
 */
export function makeCookieAdapter(currentUrl: string | undefined): PmCookieAdapter {
  const store = useCookieStore;
  return {
    forCurrentUrl() {
      if (!currentUrl) return [];
      return store.getState().getCookiesForUrl(currentUrl).map(toPmRecord);
    },
    getForUrl(url) {
      return store.getState().getCookiesForUrl(url).map(toPmRecord);
    },
    add(url, cookie) {
      const inferred = inferDomainPath(url);
      const record = {
        id: `${cookie.domain ?? inferred.domain}|${cookie.path ?? inferred.path}|${cookie.name}`,
        key: cookie.name,
        value: cookie.value,
        domain: cookie.domain ?? inferred.domain,
        path: cookie.path ?? inferred.path,
        secure: cookie.secure ?? inferred.secure,
        httpOnly: cookie.httpOnly ?? false,
        ...(cookie.expires ? { expires: cookie.expires } : {}),
      };
      store.getState().addCookie(record);
    },
    unset(url, name) {
      const matches = store
        .getState()
        .getCookiesForUrl(url)
        .filter((c) => c.key === name);
      const state = store.getState();
      for (const m of matches) state.deleteCookie(m.id);
    },
    clear(url) {
      const matches = store.getState().getCookiesForUrl(url);
      const state = store.getState();
      for (const m of matches) state.deleteCookie(m.id);
    },
  };
}
