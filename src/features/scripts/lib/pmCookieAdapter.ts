/**
 * Bridge from the QuickJS sandbox `pm.cookies` API to the renderer's
 * persistent cookie jar (`useCookieStore`).
 *
 * Postman's `pm.cookies` exposes the cookies the current request URL
 * would carry — domain + path match against the live jar. The
 * implementation is shared by every protocol executor: a single
 * `makeCookieAdapter(currentUrl)` closure captures the URL for the
 * "get/has by name" shortcuts (which Postman scopes to the request URL),
 * while `jar()` operations are URL-explicit.
 */
import { useCookieStore } from '@/features/http/store/useCookieStore';

export interface PmCookieRecord {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: string;
}

export interface PmCookieAdapter {
  /** Cookies the current request URL would carry. */
  forCurrentUrl(): PmCookieRecord[];
  /** Cookies for an arbitrary URL (matches domain/path/secure). */
  getForUrl(url: string): PmCookieRecord[];
  /** Add or update a cookie at the given URL. */
  add(url: string, cookie: PmCookieRecord): void;
  /** Remove a single cookie by name at the given URL. */
  unset(url: string, name: string): void;
  /** Remove every cookie matching the URL's domain/path. */
  clear(url: string): void;
}

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
 * `forCurrentUrl` getter is what `pm.cookies.get(name)` / `pm.cookies.has(name)`
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
