/**
 * Type-only surface for the QuickJS `pm.cookies` host bridge.
 *
 * The renderer implementation that wraps `useCookieStore` lives in
 * `pmCookieAdapter.renderer.ts` — kept separate so `scriptExecutor.ts`
 * (which re-exports these types) doesn't drag the renderer-only
 * `useCookieStore` import into the CLI's type-check graph.
 */

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
