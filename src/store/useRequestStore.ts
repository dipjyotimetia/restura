import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Request, Response, HttpRequest, GrpcRequest, ScriptResult } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { validateRequestUpdate } from '@/lib/shared/store-validators';

interface ScriptResults {
  preRequest?: ScriptResult;
  test?: ScriptResult;
}

interface RequestState {
  currentRequest: Request | null;
  currentResponse: Response | null;
  scriptResult: ScriptResults | null;
  isLoading: boolean;
  // Stored requests per protocol for preserving state when switching
  httpRequest: HttpRequest | null;
  grpcRequest: GrpcRequest | null;

  // Actions
  setCurrentRequest: (request: Request) => void;
  setCurrentResponse: (response: Response | null) => void;
  setScriptResult: (result: ScriptResults | null) => void;
  setLoading: (loading: boolean) => void;
  createNewHttpRequest: () => void;
  createNewGrpcRequest: () => void;
  switchToHttp: () => void;
  switchToGrpc: () => void;
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
      httpRequest: createDefaultHttpRequest(),
      grpcRequest: createDefaultGrpcRequest(),

      setCurrentRequest: (request) => set({ currentRequest: request }),

      setCurrentResponse: (response) => {
        set({ currentResponse: response });
      },

      setScriptResult: (result) => set({ scriptResult: result }),

      setLoading: (loading) => set({ isLoading: loading }),

      createNewHttpRequest: () => {
        const newRequest = createDefaultHttpRequest();
        set({
          currentRequest: newRequest,
          httpRequest: newRequest,
          currentResponse: null,
        });
      },

      createNewGrpcRequest: () => {
        const newRequest = createDefaultGrpcRequest();
        set({
          currentRequest: newRequest,
          grpcRequest: newRequest,
          currentResponse: null,
        });
      },

      switchToHttp: () => {
        const state = get();
        // Save current request if it's gRPC
        if (state.currentRequest?.type === 'grpc') {
          set({ grpcRequest: state.currentRequest as GrpcRequest });
        }
        // Restore or create HTTP request
        const httpReq = state.httpRequest || createDefaultHttpRequest();
        set({
          currentRequest: httpReq,
          httpRequest: httpReq,
          currentResponse: null,
        });
      },

      switchToGrpc: () => {
        const state = get();
        // Save current request if it's HTTP
        if (state.currentRequest?.type === 'http') {
          set({ httpRequest: state.currentRequest as HttpRequest });
        }
        // Restore or create gRPC request
        const grpcReq = state.grpcRequest || createDefaultGrpcRequest();
        set({
          currentRequest: grpcReq,
          grpcRequest: grpcReq,
          currentResponse: null,
        });
      },

      updateRequest: (updates) => {
        const current = get().currentRequest;
        if (current) {
          try {
            const validated = validateRequestUpdate(current, updates);
            // Also update the stored request for the current type
            if (current.type === 'http') {
              set({ currentRequest: validated, httpRequest: validated as HttpRequest });
            } else if (current.type === 'grpc') {
              set({ currentRequest: validated, grpcRequest: validated as GrpcRequest });
            } else {
              set({ currentRequest: validated });
            }
          } catch (error) {
            // If validation fails, still apply the update but log the error
            console.error('Request update validation failed:', error);
            const updated = { ...current, ...updates } as typeof current;
            if (current.type === 'http') {
              set({ currentRequest: updated, httpRequest: updated as HttpRequest });
            } else if (current.type === 'grpc') {
              set({ currentRequest: updated, grpcRequest: updated as GrpcRequest });
            } else {
              set({ currentRequest: updated });
            }
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
        httpRequest: state.httpRequest,
        grpcRequest: state.grpcRequest,
      }),
    }
  )
);
