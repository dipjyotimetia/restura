import { expandVariablesInOrder } from '@shared/variables/resolver';
import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { dexieStorageAdapters } from '@/lib/shared/dexie-storage';
import { applyDynamicVariables } from '@/lib/shared/dynamicVariables';
import { secretVariableNames } from '@/lib/shared/variableScopes';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import type { Environment, KeyValue, ScopedVariable } from '@/types';

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
  getActiveEnvironmentChain: () => Environment[];
  resolveVariables: (text: string) => string;
  createNewEnvironment: (
    name: string,
    scope?: Pick<Environment, 'collectionId' | 'parentId'>
  ) => Environment;
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

      removeEnvironment: (id) => {
        if (get().environments.some((environment) => environment.parentId === id)) return false;
        return set((state) => ({
          environments: state.environments.filter((env) => env.id !== id),
          activeEnvironmentId: state.activeEnvironmentId === id ? null : state.activeEnvironmentId,
        }));
      },

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

      getActiveEnvironmentChain: () => {
        const state = get();
        const active = state.activeEnvironmentId
          ? state.environments.find((environment) => environment.id === state.activeEnvironmentId)
          : undefined;
        if (!active) return [];
        if (!active.parentId) return [active];
        const parent = state.environments.find((environment) => environment.id === active.parentId);
        // Malformed persisted data never receives a partial inheritance chain.
        return parent && parent.collectionId === active.collectionId ? [parent, active] : [active];
      },

      resolveVariables: (text: string) => {
        // No `{{token}}` anywhere — nothing to substitute (env, globals, or
        // dynamics all require braces), so skip the scan entirely. This is the
        // common case for most fields on the per-field send hot path.
        if (!text.includes('{{')) return text;

        // Environment variables in definition order, then workspace globals for
        // whatever tokens are still present, so an env var with the same name wins.
        // Going through here gives every caller of resolveVariables — SSE / WebSocket
        // / Socket.IO / MCP / gRPC / workflows / the HTTP second pass — globals parity
        // for free. Built-in dynamics (Postman-name compatible) expand once at the
        // very end, so a helper in a value is never generated twice.
        const enabled = (get().getActiveEnvironment()?.variables ?? []).filter((v) => v.enabled);
        // A secret answers only a token written in `text`. One reached through a
        // value stays literal here; the send path refuses it (resolveRequestScope).
        const secret = new Set(secretVariableNames(enabled));
        const afterEnv = expandVariablesInOrder(
          text,
          enabled.map((v) => [v.key, v.value] as const),
          secret.size > 0 ? { directOnly: (name) => secret.has(name) } : {}
        );
        return applyDynamicVariables(
          expandVariablesInOrder(afterEnv, Object.entries(useGlobalsStore.getState().vars))
        );
      },

      createNewEnvironment: (name, scope) => ({
        id: uuidv4(),
        name,
        variables: [],
        ...(scope?.collectionId !== undefined ? { collectionId: scope.collectionId } : {}),
        ...(scope?.parentId !== undefined ? { parentId: scope.parentId } : {}),
      }),
    }),
    {
      name: 'environment-storage',
      version: 3,
      storage: dexieStorageAdapters.environments(),
      migrate: (persistedState) => {
        const state = persistedState as Partial<EnvironmentState> | null;
        if (!state?.environments) return state as EnvironmentState;
        return {
          ...state,
          environments: state.environments.map((environment) => ({
            ...environment,
            variables: environment.variables.map((variable): ScopedVariable => ({ ...variable })),
          })),
        } as EnvironmentState;
      },
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
