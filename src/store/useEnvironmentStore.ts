import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { applyDynamicVariables } from '@/lib/shared/dynamicVariables';
import { escapeRegExp } from '@/lib/shared/escapeRegExp';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import type { Environment, KeyValue } from '@/types';

interface EnvironmentState {
  environments: Environment[];
  activeEnvironmentId: string | null;

  // Actions
  addEnvironment: (environment: Environment) => void;
  updateEnvironment: (id: string, updates: Partial<Environment>) => void;
  removeEnvironment: (id: string) => void;
  setActiveEnvironment: (id: string | null) => void;
  addVariable: (environmentId: string, variable: KeyValue) => void;
  updateVariable: (environmentId: string, variableId: string, updates: Partial<KeyValue>) => void;
  removeVariable: (environmentId: string, variableId: string) => void;
  getActiveEnvironment: () => Environment | null;
  resolveVariables: (text: string) => string;
  createNewEnvironment: (name: string) => Environment;
}

export const useEnvironmentStore = create<EnvironmentState>()(
  persist(
    (set, get) => ({
      environments: [],
      activeEnvironmentId: null,

      addEnvironment: (environment) =>
        set((state) => ({
          environments: [...state.environments, environment],
        })),

      updateEnvironment: (id, updates) =>
        set((state) => ({
          environments: state.environments.map((env) =>
            env.id === id ? { ...env, ...updates } : env
          ),
        })),

      removeEnvironment: (id) =>
        set((state) => ({
          environments: state.environments.filter((env) => env.id !== id),
          activeEnvironmentId: state.activeEnvironmentId === id ? null : state.activeEnvironmentId,
        })),

      setActiveEnvironment: (id) => set({ activeEnvironmentId: id }),

      addVariable: (environmentId, variable) =>
        set((state) => ({
          environments: state.environments.map((env) =>
            env.id === environmentId ? { ...env, variables: [...env.variables, variable] } : env
          ),
        })),

      updateVariable: (environmentId, variableId, updates) =>
        set((state) => ({
          environments: state.environments.map((env) =>
            env.id === environmentId
              ? {
                  ...env,
                  variables: env.variables.map((v) =>
                    v.id === variableId ? { ...v, ...updates } : v
                  ),
                }
              : env
          ),
        })),

      removeVariable: (environmentId, variableId) =>
        set((state) => ({
          environments: state.environments.map((env) =>
            env.id === environmentId
              ? {
                  ...env,
                  variables: env.variables.filter((v) => v.id !== variableId),
                }
              : env
          ),
        })),

      getActiveEnvironment: () => {
        const state = get();
        if (!state.activeEnvironmentId) return null;
        return state.environments.find((env) => env.id === state.activeEnvironmentId) || null;
      },

      resolveVariables: (text: string) => {
        const activeEnv = get().getActiveEnvironment();
        let resolved = text;

        // Resolve environment variables first
        if (activeEnv) {
          activeEnv.variables.forEach((variable) => {
            if (variable.enabled) {
              // escapeRegExp: a key with regex metachars would crash the RegExp
              // ctor; the function replacer keeps a value with $ patterns literal.
              const regex = new RegExp(`{{\\s*${escapeRegExp(variable.key)}\\s*}}`, 'g');
              resolved = resolved.replace(regex, () => variable.value);
            }
          });
        }

        // Then workspace globals fill any still-unresolved tokens. Env is applied
        // first, so an env var with the same name wins (its token is already gone).
        // This gives every caller of resolveVariables — SSE / WebSocket / Socket.IO /
        // MCP / gRPC / workflows / the HTTP second pass — globals parity for free.
        const globals = useGlobalsStore.getState().vars;
        for (const [key, value] of Object.entries(globals)) {
          const regex = new RegExp(`{{\\s*${escapeRegExp(key)}\\s*}}`, 'g');
          resolved = resolved.replace(regex, () => value);
        }

        // Resolve built-in dynamic variables (Postman-name compatible)
        return applyDynamicVariables(resolved);
      },

      createNewEnvironment: (name) => ({
        id: uuidv4(),
        name,
        variables: [],
      }),
    }),
    {
      name: 'environment-storage',
      version: 2,
      storage: dexieStorageAdapters.environments(),
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.error('Environment store rehydration failed:', error);
        }
        if (state) {
          console.debug('Environment store rehydrated from Dexie successfully');
        }
      },
    }
  )
);
