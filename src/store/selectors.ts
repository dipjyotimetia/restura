import type {
  Response as ApiResponse,
  Collection,
  Environment,
  GrpcRequest,
  HistoryItem,
  HttpRequest,
  McpRequest,
  RequestTab,
  SseRequest,
  StreamEventLike,
} from '@/types';
import { useRequestStore } from './useRequestStore';

interface HistoryState {
  history: HistoryItem[];
  favorites: string[];
}

interface CollectionState {
  collections: Collection[];
}

interface EnvironmentState {
  environments: Environment[];
  activeEnvironmentId: string | null;
}

export const selectHistoryPage =
  (page: number, pageSize: number) =>
  (state: HistoryState): HistoryItem[] =>
    state.history.slice(page * pageSize, (page + 1) * pageSize);

export const selectHistoryCount = (state: HistoryState): number => state.history.length;

export const selectHistoryTotalPages =
  (pageSize: number) =>
  (state: HistoryState): number =>
    Math.ceil(state.history.length / pageSize);

export const selectFavoriteIds = (state: HistoryState): string[] => state.favorites;

export const selectFavoriteItems = (state: HistoryState): HistoryItem[] =>
  state.history.filter((item) => state.favorites.includes(item.id));

export const selectIsFavorite =
  (id: string) =>
  (state: HistoryState): boolean =>
    state.favorites.includes(id);

export const selectHistoryById =
  (id: string) =>
  (state: HistoryState): HistoryItem | undefined =>
    state.history.find((item) => item.id === id);

export const selectCollectionNames = (
  state: CollectionState
): Array<{ id: string; name: string }> =>
  state.collections.map((c) => ({ id: c.id, name: c.name }));

export const selectCollectionCount = (state: CollectionState): number => state.collections.length;

export const selectCollectionById =
  (id: string) =>
  (state: CollectionState): Collection | undefined =>
    state.collections.find((c) => c.id === id);

export const selectCollectionItemsCount =
  (id: string) =>
  (state: CollectionState): number =>
    state.collections.find((c) => c.id === id)?.items.length ?? 0;

export const selectActiveEnvironment = (state: EnvironmentState): Environment | undefined =>
  state.environments.find((env) => env.id === state.activeEnvironmentId);

export const selectEnvironmentNames = (
  state: EnvironmentState
): Array<{ id: string; name: string }> =>
  state.environments.map((env) => ({ id: env.id, name: env.name }));

export const selectEnvironmentCount = (state: EnvironmentState): number =>
  state.environments.length;

/** The currently active tab, or null if none. */
export function useActiveTab(): RequestTab | null {
  return useRequestStore((s) =>
    s.activeTabId ? (s.tabs.find((t) => t.id === s.activeTabId) ?? null) : null
  );
}

/**
 * Just the active tab's id. Subscribes to a single primitive so the consumer
 * doesn't re-render on every tab field change.
 */
export function useActiveTabId(): string | null {
  return useRequestStore((s) => s.activeTabId);
}

/** The active tab's request, narrowed to the given type, or null if no tab or wrong type. */
export function useActiveRequest(type: 'http'): HttpRequest | null;
export function useActiveRequest(type: 'grpc'): GrpcRequest | null;
export function useActiveRequest(type: 'sse'): SseRequest | null;
export function useActiveRequest(type: 'mcp'): McpRequest | null;
export function useActiveRequest(
  type: 'http' | 'grpc' | 'sse' | 'mcp'
): HttpRequest | GrpcRequest | SseRequest | McpRequest | null {
  return useRequestStore((s) => {
    const tab = s.activeTabId ? s.tabs.find((t) => t.id === s.activeTabId) : null;
    if (!tab || tab.request.type !== type) return null;
    return tab.request as HttpRequest | GrpcRequest | SseRequest | McpRequest;
  });
}

/** The active tab's last response, or null. */
export function useActiveResponse(): ApiResponse | null {
  return useRequestStore((s) => {
    const tab = s.activeTabId ? s.tabs.find((t) => t.id === s.activeTabId) : null;
    return tab?.response ?? null;
  });
}

/**
 * The active tab's in-flight streaming events iterator, or null. Components
 * branch on this to render `StreamingResponseViewer` instead of the buffered
 * Monaco view.
 */
export function useActiveStreamingEvents(): AsyncIterable<StreamEventLike> | null {
  return useRequestStore((s) => {
    const tab = s.activeTabId ? s.tabs.find((t) => t.id === s.activeTabId) : null;
    return tab?.streamingEvents ?? null;
  });
}
