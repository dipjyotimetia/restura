import { create } from 'zustand';

/**
 * Server→client MCP requests awaiting the user (#860). Runtime-only: a parked
 * prompt belongs to a live desktop session, so nothing here is persisted.
 */
export type McpClientRequestKind = 'elicitation' | 'sampling';

export interface McpPendingClientRequest {
  requestId: string;
  connectionId: string;
  kind: McpClientRequestKind;
  params: unknown;
  receivedAt: number;
}

interface McpClientRequestState {
  requests: McpPendingClientRequest[];
  add: (request: McpPendingClientRequest) => void;
  remove: (requestId: string) => void;
  clearConnection: (connectionId: string) => void;
}

/** Bound mirrors main's per-connection cap; extra prompts are dropped (main times them out). */
const MAX_QUEUED = 32;

export const useMcpClientRequestStore = create<McpClientRequestState>()((set) => ({
  requests: [],
  add: (request) =>
    set((state) =>
      state.requests.some((existing) => existing.requestId === request.requestId) ||
      state.requests.length >= MAX_QUEUED
        ? state
        : { requests: [...state.requests, request] }
    ),
  remove: (requestId) =>
    set((state) => ({
      requests: state.requests.filter((request) => request.requestId !== requestId),
    })),
  clearConnection: (connectionId) =>
    set((state) => ({
      requests: state.requests.filter((request) => request.connectionId !== connectionId),
    })),
}));
