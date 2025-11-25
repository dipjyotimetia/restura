import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';

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
}

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

          return get().cookies.filter((cookie) => {
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
    }),
    {
      name: 'restura-cookies',
      version: 2, // Bumped for Dexie migration
      storage: dexieStorageAdapters.cookies(),
      migrate: (persistedState, version) => {
        // Handle migrations between versions
        if (version === 0 || version === 1) {
          // Migration from localStorage (v1) to Dexie (v2)
          return persistedState as CookieStore;
        }
        return persistedState as CookieStore;
      },
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.error('Cookie store rehydration failed:', error);
          // Store will use default state on error
        }
        if (state) {
          console.debug('Cookie store rehydrated from Dexie successfully');
        }
      },
    }
  )
);
