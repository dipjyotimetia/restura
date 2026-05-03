import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { IntrospectionResult } from '@/features/graphql/types';
import type { IntrospectionOptions } from '@/features/graphql/lib/introspection';
import { introspectSchema } from '@/features/graphql/lib/introspection';

interface GraphQLSchemaState {
  // Cached schemas by endpoint URL
  schemas: Record<string, IntrospectionResult>;

  // Currently selected endpoint
  activeEndpoint: string | null;

  // Loading state per endpoint
  loading: Record<string, boolean>;

  // Actions
  fetchSchema: (endpoint: string, options?: IntrospectionOptions) => Promise<IntrospectionResult>;
  getSchema: (endpoint: string) => IntrospectionResult | null;
  clearSchema: (endpoint: string) => void;
  clearAllSchemas: () => void;
  setActiveEndpoint: (endpoint: string | null) => void;
  isLoading: (endpoint: string) => boolean;
}

const CACHE_DURATION_MS = 60 * 60 * 1000;
const ERROR_CACHE_DURATION_MS = 5 * 60 * 1000;

export const useGraphQLSchemaStore = create<GraphQLSchemaState>()(
  persist(
    (set, get) => ({
      schemas: {},
      activeEndpoint: null,
      loading: {},

      fetchSchema: async (endpoint, options) => {
        const cached = get().schemas[endpoint];
        if (cached) {
          const age = Date.now() - cached.timestamp;
          const ttl = cached.success ? CACHE_DURATION_MS : ERROR_CACHE_DURATION_MS;
          if (age < ttl) return cached;
        }

        // Set loading state
        set((state) => ({
          loading: { ...state.loading, [endpoint]: true },
        }));

        try {
          const result = await introspectSchema(endpoint, options);

          set((state) => ({
            schemas: { ...state.schemas, [endpoint]: result },
            loading: { ...state.loading, [endpoint]: false },
          }));

          return result;
        } catch (error) {
          const errorResult: IntrospectionResult = {
            success: false,
            schema: null,
            error: error instanceof Error ? error.message : 'Unknown error',
            endpoint,
            timestamp: Date.now(),
          };

          set((state) => ({
            schemas: { ...state.schemas, [endpoint]: errorResult },
            loading: { ...state.loading, [endpoint]: false },
          }));

          return errorResult;
        }
      },

      getSchema: (endpoint) => {
        return get().schemas[endpoint] || null;
      },

      clearSchema: (endpoint) => {
        set((state) => {
          const { [endpoint]: _, ...rest } = state.schemas;
          return { schemas: rest };
        });
      },

      clearAllSchemas: () => {
        set({ schemas: {} });
      },

      setActiveEndpoint: (endpoint) => {
        set({ activeEndpoint: endpoint });
      },

      isLoading: (endpoint) => {
        return get().loading[endpoint] || false;
      },
    }),
    {
      name: 'graphql-schema-storage',
      partialize: (state) => ({
        // Only persist schemas, not loading state
        schemas: state.schemas,
        activeEndpoint: state.activeEndpoint,
      }),
    }
  )
);
