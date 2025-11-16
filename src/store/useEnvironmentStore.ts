import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Environment, KeyValue } from '@/types';
import { v4 as uuidv4 } from 'uuid';

interface EnvironmentState {
  environments: Environment[];
  activeEnvironmentId: string | null;

  // Actions
  addEnvironment: (environment: Environment) => void;
  updateEnvironment: (id: string, updates: Partial<Environment>) => void;
  deleteEnvironment: (id: string) => void;
  setActiveEnvironment: (id: string | null) => void;
  addVariable: (environmentId: string, variable: KeyValue) => void;
  updateVariable: (environmentId: string, variableId: string, updates: Partial<KeyValue>) => void;
  deleteVariable: (environmentId: string, variableId: string) => void;
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

      deleteEnvironment: (id) =>
        set((state) => ({
          environments: state.environments.filter((env) => env.id !== id),
          activeEnvironmentId: state.activeEnvironmentId === id ? null : state.activeEnvironmentId,
        })),

      setActiveEnvironment: (id) => set({ activeEnvironmentId: id }),

      addVariable: (environmentId, variable) =>
        set((state) => ({
          environments: state.environments.map((env) =>
            env.id === environmentId
              ? { ...env, variables: [...env.variables, variable] }
              : env
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

      deleteVariable: (environmentId, variableId) =>
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
        if (!activeEnv) return text;

        let resolved = text;
        activeEnv.variables.forEach((variable) => {
          if (variable.enabled) {
            const regex = new RegExp(`{{\\s*${variable.key}\\s*}}`, 'g');
            resolved = resolved.replace(regex, variable.value);
          }
        });

        return resolved;
      },

      createNewEnvironment: (name) => ({
        id: uuidv4(),
        name,
        variables: [],
      }),
    }),
    {
      name: 'environment-storage',
    }
  )
);
