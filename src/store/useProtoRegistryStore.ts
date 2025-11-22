import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ProtoServiceDefinition } from '@/types';

export interface ProtoFileEntry {
  id: string;
  name: string;
  content: string;
  package: string;
  services: ProtoServiceDefinition[];
  addedAt: number;
  lastUsedAt: number;
}

interface ProtoRegistryState {
  protos: Record<string, ProtoFileEntry>;

  // Actions
  addProto: (name: string, content: string, packageName: string, services: ProtoServiceDefinition[]) => string;
  updateProto: (id: string, updates: Partial<Omit<ProtoFileEntry, 'id'>>) => void;
  deleteProto: (id: string) => void;
  getProtoById: (id: string) => ProtoFileEntry | undefined;
  getProtoByService: (serviceName: string) => ProtoFileEntry | undefined;
  markUsed: (id: string) => void;
  clearRegistry: () => void;

  // Computed
  getAllProtos: () => ProtoFileEntry[];
  getRecentProtos: (limit?: number) => ProtoFileEntry[];
  searchProtos: (query: string) => ProtoFileEntry[];
}

export const useProtoRegistryStore = create<ProtoRegistryState>()(
  persist(
    (set, get) => ({
      protos: {},

      addProto: (name, content, packageName, services) => {
        const id = `proto-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const entry: ProtoFileEntry = {
          id,
          name,
          content,
          package: packageName,
          services,
          addedAt: Date.now(),
          lastUsedAt: Date.now(),
        };

        set((state) => ({
          protos: { ...state.protos, [id]: entry },
        }));

        return id;
      },

      updateProto: (id, updates) =>
        set((state) => {
          const proto = state.protos[id];
          if (!proto) return state;

          return {
            protos: {
              ...state.protos,
              [id]: { ...proto, ...updates },
            },
          };
        }),

      deleteProto: (id) =>
        set((state) => {
          const { [id]: _, ...rest } = state.protos;
          return { protos: rest };
        }),

      getProtoById: (id) => get().protos[id],

      getProtoByService: (serviceName) => {
        const protos = Object.values(get().protos);
        return protos.find((proto) =>
          proto.services.some(
            (s) => s.fullName === serviceName || s.name === serviceName
          )
        );
      },

      markUsed: (id) =>
        set((state) => {
          const proto = state.protos[id];
          if (!proto) return state;

          return {
            protos: {
              ...state.protos,
              [id]: { ...proto, lastUsedAt: Date.now() },
            },
          };
        }),

      clearRegistry: () => set({ protos: {} }),

      getAllProtos: () => {
        return Object.values(get().protos).sort(
          (a, b) => b.addedAt - a.addedAt
        );
      },

      getRecentProtos: (limit = 5) => {
        return Object.values(get().protos)
          .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
          .slice(0, limit);
      },

      searchProtos: (query) => {
        const lowerQuery = query.toLowerCase();
        return Object.values(get().protos).filter(
          (proto) =>
            proto.name.toLowerCase().includes(lowerQuery) ||
            proto.package.toLowerCase().includes(lowerQuery) ||
            proto.services.some(
              (s) =>
                s.name.toLowerCase().includes(lowerQuery) ||
                s.fullName.toLowerCase().includes(lowerQuery)
            )
        );
      },
    }),
    {
      name: 'proto-registry-storage',
    }
  )
);
