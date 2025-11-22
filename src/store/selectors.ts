/**
 * Memoized selectors for Zustand stores
 * Use these with shallow equality for optimal re-render performance
 */

import type { HistoryItem, Collection, Environment } from '@/types';

// History Store Types
interface HistoryState {
  history: HistoryItem[];
  favorites: string[];
}

// Collection Store Types
interface CollectionState {
  collections: Collection[];
}

// Environment Store Types
interface EnvironmentState {
  environments: Environment[];
  activeEnvironmentId: string | null;
}

// ============================================================================
// History Selectors
// ============================================================================

/**
 * Select paginated history items
 */
export const selectHistoryPage = (page: number, pageSize: number) =>
  (state: HistoryState): HistoryItem[] =>
    state.history.slice(page * pageSize, (page + 1) * pageSize);

/**
 * Select total history count
 */
export const selectHistoryCount = (state: HistoryState): number =>
  state.history.length;

/**
 * Select total number of pages
 */
export const selectHistoryTotalPages = (pageSize: number) =>
  (state: HistoryState): number =>
    Math.ceil(state.history.length / pageSize);

/**
 * Select favorite item IDs
 */
export const selectFavoriteIds = (state: HistoryState): string[] =>
  state.favorites;

/**
 * Select favorite history items
 */
export const selectFavoriteItems = (state: HistoryState): HistoryItem[] =>
  state.history.filter(item => state.favorites.includes(item.id));

/**
 * Check if an item is a favorite
 */
export const selectIsFavorite = (id: string) =>
  (state: HistoryState): boolean =>
    state.favorites.includes(id);

/**
 * Select history item by ID
 */
export const selectHistoryById = (id: string) =>
  (state: HistoryState): HistoryItem | undefined =>
    state.history.find(item => item.id === id);

// ============================================================================
// Collection Selectors
// ============================================================================

/**
 * Select collection names only (for lists)
 */
export const selectCollectionNames = (state: CollectionState): Array<{ id: string; name: string }> =>
  state.collections.map(c => ({ id: c.id, name: c.name }));

/**
 * Select collection count
 */
export const selectCollectionCount = (state: CollectionState): number =>
  state.collections.length;

/**
 * Select collection by ID
 */
export const selectCollectionById = (id: string) =>
  (state: CollectionState): Collection | undefined =>
    state.collections.find(c => c.id === id);

/**
 * Select collection items count
 */
export const selectCollectionItemsCount = (id: string) =>
  (state: CollectionState): number =>
    state.collections.find(c => c.id === id)?.items.length ?? 0;

// ============================================================================
// Environment Selectors
// ============================================================================

/**
 * Select active environment
 */
export const selectActiveEnvironment = (state: EnvironmentState): Environment | undefined =>
  state.environments.find(env => env.id === state.activeEnvironmentId);

/**
 * Select environment names only
 */
export const selectEnvironmentNames = (state: EnvironmentState): Array<{ id: string; name: string }> =>
  state.environments.map(env => ({ id: env.id, name: env.name }));

/**
 * Select environment count
 */
export const selectEnvironmentCount = (state: EnvironmentState): number =>
  state.environments.length;
