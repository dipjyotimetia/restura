import type { CookieHop } from '@shared/protocol/set-cookie';
import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { applySetCookies, type CookieItem, cookiesForUrl } from '@/features/http/lib/cookieJar';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';

export type { CookieItem };

interface CookieStore {
  cookies: CookieItem[];
  addCookie: (cookie: CookieItem) => void;
  /** Store a response's Set-Cookie fields, each hop against its own URL (RFC 6265 §5.3). */
  storeResponseCookies: (hops: readonly CookieHop[]) => void;
  updateCookie: (id: string, updates: Partial<CookieItem>) => void;
  deleteCookie: (id: string) => void;
  getCookiesForUrl: (url: string) => CookieItem[];
  clearCookies: () => void;
  purgeExpired: () => void;
}

// Purge expired cookies once per hour during long sessions
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

export const useCookieStore = create<CookieStore>()(
  persist(
    (set, get) => ({
      cookies: [],
      addCookie: (cookie) =>
        set((state) => {
          // Check if cookie already exists (by domain, path, key)
          const existsIndex = state.cookies.findIndex(
            (c) => c.domain === cookie.domain && c.path === cookie.path && c.key === cookie.key
          );

          if (existsIndex >= 0) {
            // Update existing
            const newCookies = [...state.cookies];
            const existingCookie = state.cookies[existsIndex];
            if (existingCookie) {
              newCookies[existsIndex] = { ...cookie, id: existingCookie.id };
            }
            return { cookies: newCookies };
          }

          return { cookies: [...state.cookies, cookie] };
        }),
      storeResponseCookies: (hops) => {
        if (hops.length === 0) return;
        set((state) => ({ cookies: applySetCookies(state.cookies, hops, Date.now(), uuidv4) }));
      },
      updateCookie: (id, updates) =>
        set((state) => ({
          cookies: state.cookies.map((c) => (c.id === id ? { ...c, ...updates } : c)),
        })),
      deleteCookie: (id) =>
        set((state) => ({
          cookies: state.cookies.filter((c) => c.id !== id),
        })),
      getCookiesForUrl: (url) => cookiesForUrl(get().cookies, url, Date.now()),
      clearCookies: () => set({ cookies: [] }),
      purgeExpired: () =>
        set((state) => ({
          cookies: state.cookies.filter((c) => {
            if (!c.expires) return true;
            const expiry = new Date(c.expires).getTime();
            return Number.isNaN(expiry) || expiry > Date.now();
          }),
        })),
    }),
    {
      name: 'restura-cookies',
      version: 2,
      storage: dexieStorageAdapters.cookies(),
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.error('Cookie store rehydration failed:', error);
        }
        if (state) {
          state.purgeExpired();
          // Schedule periodic purge for long-running sessions
          setInterval(() => useCookieStore.getState().purgeExpired(), PURGE_INTERVAL_MS);
        }
      },
    }
  )
);
