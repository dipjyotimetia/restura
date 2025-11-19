import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Request, Response, HttpRequest, GrpcRequest, ScriptResult } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { validateRequestUpdate } from '@/lib/store-validators';

interface ScriptResults {
  preRequest?: ScriptResult;
  test?: ScriptResult;
}

interface RequestState {
  currentRequest: Request | null;
  currentResponse: Response | null;
  scriptResult: ScriptResults | null;
  isLoading: boolean;

  // Actions
  setCurrentRequest: (request: Request) => void;
  setCurrentResponse: (response: Response | null) => void;
  setScriptResult: (result: ScriptResults | null) => void;
  setLoading: (loading: boolean) => void;
  createNewHttpRequest: () => void;
  createNewGrpcRequest: () => void;
  updateRequest: (updates: Partial<Request>) => void;
  clearRequest: () => void;
}

const createDefaultHttpRequest = (): HttpRequest => ({
  id: uuidv4(),
  name: 'New Request',
  type: 'http',
  method: 'GET',
  url: '',
  headers: [],
  params: [],
  body: {
    type: 'none',
  },
  auth: {
    type: 'none',
  },
});

const createDefaultGrpcRequest = (): GrpcRequest => ({
  id: uuidv4(),
  name: 'New gRPC Request',
  type: 'grpc',
  methodType: 'unary',
  url: '',
  service: '',
  method: '',
  metadata: [],
  message: '',
  auth: {
    type: 'none',
  },
});

export const useRequestStore = create<RequestState>()(
  persist(
    (set, get) => ({
      currentRequest: createDefaultHttpRequest(),
      currentResponse: null,
      scriptResult: null,
      isLoading: false,

      setCurrentRequest: (request) => set({ currentRequest: request }),

      setCurrentResponse: (response) => set({ currentResponse: response }),

      setScriptResult: (result) => set({ scriptResult: result }),

      setLoading: (loading) => set({ isLoading: loading }),

      createNewHttpRequest: () => set({
        currentRequest: createDefaultHttpRequest(),
        currentResponse: null,
      }),

      createNewGrpcRequest: () => set({
        currentRequest: createDefaultGrpcRequest(),
        currentResponse: null,
      }),

      updateRequest: (updates) => {
        const current = get().currentRequest;
        if (current) {
          try {
            const validated = validateRequestUpdate(current, updates);
            set({ currentRequest: validated });
          } catch (error) {
            // If validation fails, still apply the update but log the error
            console.error('Request update validation failed:', error);
            // Apply updates without validation (for partial edits)
            set({ currentRequest: { ...current, ...updates } as typeof current });
          }
        }
      },

      clearRequest: () => set({
        currentRequest: null,
        currentResponse: null,
        scriptResult: null,
      }),
    }),
    {
      name: 'request-storage',
      partialize: (state) => ({
        currentRequest: state.currentRequest,
      }),
    }
  )
);
