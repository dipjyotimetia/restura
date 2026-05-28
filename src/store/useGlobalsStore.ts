/**
 * Postman-compatible `pm.globals` scope — a single workspace-wide
 * key-value store that persists across environment switches. Distinct
 * from `useEnvironmentStore` (per-environment vars) and from per-request
 * collection variables.
 *
 * Reads/writes happen during script execution via `pm.globals.get/set/unset`;
 * the script executor surfaces mutations on `ScriptResult.globalsMutations`,
 * and the request executor merges them back here via `applyMutations`.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';

interface GlobalsState {
  vars: Record<string, string>;

  get: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
  unset: (key: string) => void;
  clear: () => void;
  /** Bulk apply per-key mutations: `null` removes the key, a string sets it. */
  applyMutations: (mutations: Record<string, string | null>) => void;
}

export const useGlobalsStore = create<GlobalsState>()(
  persist(
    (set, get) => ({
      vars: {},

      get: (key) => get().vars[key],

      set: (key, value) => set((state) => ({ vars: { ...state.vars, [key]: value } })),

      unset: (key) =>
        set((state) => {
          if (!(key in state.vars)) return state;
          const next = { ...state.vars };
          delete next[key];
          return { vars: next };
        }),

      clear: () => set({ vars: {} }),

      applyMutations: (mutations) =>
        set((state) => {
          let changed = false;
          const next = { ...state.vars };
          for (const [k, v] of Object.entries(mutations)) {
            if (v === null) {
              if (k in next) {
                delete next[k];
                changed = true;
              }
            } else if (next[k] !== v) {
              next[k] = v;
              changed = true;
            }
          }
          return changed ? { vars: next } : state;
        }),
    }),
    {
      name: 'globals-storage',
      version: 1,
      storage: dexieStorageAdapters.globals(),
      onRehydrateStorage: () => (_state, error) => {
        if (error) {
          console.error('Globals store rehydration failed:', error);
        }
      },
    }
  )
);
