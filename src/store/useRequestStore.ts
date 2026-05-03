import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Request, Response, HttpRequest, GrpcRequest, SseRequest, McpRequest, ScriptResult } from '@/types';
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
  sseRequest: SseRequest | null;
  mcpRequest: McpRequest | null;

  // Actions
  setCurrentRequest: (request: Request) => void;
  setCurrentResponse: (response: Response | null) => void;
  setScriptResult: (result: ScriptResults | null) => void;
  setLoading: (loading: boolean) => void;
  createNewHttpRequest: () => void;
  createNewGrpcRequest: () => void;
  createNewSseRequest: () => void;
  createNewMcpRequest: () => void;
  switchToHttp: () => void;
  switchToGrpc: () => void;
  switchToSse: () => void;
  switchToMcp: () => void;
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

const createDefaultSseRequest = (): SseRequest => ({
  id: uuidv4(),
  name: 'New SSE Request',
  type: 'sse',
  url: '',
  headers: [],
  params: [],
  auth: {
    type: 'none',
  },
  reconnectOnResume: true,
});

const createDefaultMcpRequest = (): McpRequest => ({
  id: uuidv4(),
  name: 'New MCP Request',
  type: 'mcp',
  url: '',
  transport: 'streamable-http',
  headers: [],
  auth: {
    type: 'none',
  },
});

// Stash the active request in its per-type slot before swapping to a new type,
// so per-protocol edits round-trip across mode switches.
function persistActiveByType(state: { currentRequest: Request | null }) {
  const r = state.currentRequest;
  if (!r) return {};
  switch (r.type) {
    case 'http': return { httpRequest: r };
    case 'grpc': return { grpcRequest: r };
    case 'sse':  return { sseRequest: r };
    case 'mcp':  return { mcpRequest: r };
  }
}

export const useRequestStore = create<RequestState>()(
  persist(
    (set, get) => ({
      currentRequest: createDefaultHttpRequest(),
      currentResponse: null,
      scriptResult: null,
      isLoading: false,
      httpRequest: createDefaultHttpRequest(),
      grpcRequest: createDefaultGrpcRequest(),
      sseRequest: createDefaultSseRequest(),
      mcpRequest: createDefaultMcpRequest(),

      setCurrentRequest: (request) => set({ currentRequest: request }),

      setCurrentResponse: (response) => {
        set({ currentResponse: response });
      },

      setScriptResult: (result) => set({ scriptResult: result }),

      setLoading: (loading) => set({ isLoading: loading }),

      createNewHttpRequest: () => {
        const newRequest = createDefaultHttpRequest();
        set({ currentRequest: newRequest, httpRequest: newRequest, currentResponse: null });
      },

      createNewGrpcRequest: () => {
        const newRequest = createDefaultGrpcRequest();
        set({ currentRequest: newRequest, grpcRequest: newRequest, currentResponse: null });
      },

      createNewSseRequest: () => {
        const newRequest = createDefaultSseRequest();
        set({ currentRequest: newRequest, sseRequest: newRequest, currentResponse: null });
      },

      createNewMcpRequest: () => {
        const newRequest = createDefaultMcpRequest();
        set({ currentRequest: newRequest, mcpRequest: newRequest, currentResponse: null });
      },

      switchToHttp: () => {
        const state = get();
        const persisted = persistActiveByType(state);
        const httpReq = state.httpRequest || createDefaultHttpRequest();
        set({ ...persisted, currentRequest: httpReq, httpRequest: httpReq, currentResponse: null });
      },

      switchToGrpc: () => {
        const state = get();
        const persisted = persistActiveByType(state);
        const grpcReq = state.grpcRequest || createDefaultGrpcRequest();
        set({ ...persisted, currentRequest: grpcReq, grpcRequest: grpcReq, currentResponse: null });
      },

      switchToSse: () => {
        const state = get();
        const persisted = persistActiveByType(state);
        const sseReq = state.sseRequest || createDefaultSseRequest();
        set({ ...persisted, currentRequest: sseReq, sseRequest: sseReq, currentResponse: null });
      },

      switchToMcp: () => {
        const state = get();
        const persisted = persistActiveByType(state);
        const mcpReq = state.mcpRequest || createDefaultMcpRequest();
        set({ ...persisted, currentRequest: mcpReq, mcpRequest: mcpReq, currentResponse: null });
      },

      updateRequest: (updates) => {
        const current = get().currentRequest;
        if (!current) return;
        let next: Request;
        try {
          next = validateRequestUpdate(current, updates);
        } catch (error) {
          // Soft-validation: log and apply anyway so the user isn't locked out of bad-but-recoverable state.
          console.error('Request update validation failed:', error);
          next = { ...current, ...updates } as Request;
        }
        switch (next.type) {
          case 'http': set({ currentRequest: next, httpRequest: next as HttpRequest }); break;
          case 'grpc': set({ currentRequest: next, grpcRequest: next as GrpcRequest }); break;
          case 'sse':  set({ currentRequest: next, sseRequest:  next as SseRequest });  break;
          case 'mcp':  set({ currentRequest: next, mcpRequest:  next as McpRequest });  break;
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
        sseRequest: state.sseRequest,
        mcpRequest: state.mcpRequest,
      }),
    }
  )
);
