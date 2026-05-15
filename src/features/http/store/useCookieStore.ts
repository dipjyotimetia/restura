import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { migrateLegacyLocalStorage } from '@/lib/shared/migrate-legacy-storage';

export interface CookieItem {
  id: string;
  key: string;
  value: string;
  domain: string;
  path: string;
  expires?: string;
  secure: boolean;
  httpOnly: boolean;
  lastAccessed?: string;
}

interface CookieStore {
  cookies: CookieItem[];
  addCookie: (cookie: CookieItem) => void;
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
            (c) =>
              c.domain === cookie.domain &&
              c.path === cookie.path &&
              c.key === cookie.key
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
      updateCookie: (id, updates) =>
        set((state) => ({
          cookies: state.cookies.map((c) => (c.id === id ? { ...c, ...updates } : c)),
        })),
      deleteCookie: (id) =>
        set((state) => ({
          cookies: state.cookies.filter((c) => c.id !== id),
        })),
      getCookiesForUrl: (url) => {
        try {
          const urlObj = new URL(url);
          const hostname = urlObj.hostname;
          const pathname = urlObj.pathname;

          const now = Date.now();
          return get().cookies.filter((cookie) => {
            // Skip expired cookies
            if (cookie.expires) {
              const expiry = new Date(cookie.expires).getTime();
              if (!isNaN(expiry) && expiry <= now) return false;
            }

            // Domain matching (simplified)
            const domainMatch =
              hostname === cookie.domain || hostname.endsWith('.' + cookie.domain);

            // Path matching
            const pathMatch = pathname.startsWith(cookie.path);

            // Secure matching
            const secureMatch = cookie.secure ? urlObj.protocol === 'https:' : true;

            return domainMatch && pathMatch && secureMatch;
          });
        } catch {
          return [];
        }
      },
      clearCookies: () => set({ cookies: [] }),
      purgeExpired: () =>
        set((state) => ({
          cookies: state.cookies.filter((c) => {
            if (!c.expires) return true;
            const expiry = new Date(c.expires).getTime();
            return isNaN(expiry) || expiry > Date.now();
          }),
        })),
    }),
    {
      name: 'restura-cookies',
      version: 2,
      storage: dexieStorageAdapters.cookies(),
      migrate: (persistedState, _version) => {
        const looksEmpty =
          !persistedState ||
          (typeof persistedState === 'object' &&
            Object.keys(persistedState as object).length === 0);
        if (looksEmpty) {
          const legacy = migrateLegacyLocalStorage<Partial<CookieStore>>(
            'restura-cookies'
          );
          if (legacy) return legacy as CookieStore;
        }
        return persistedState as CookieStore;
      },
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
