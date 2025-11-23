import { describe, it, expect } from 'vitest';
import {
  selectHistoryPage,
  selectHistoryCount,
  selectHistoryTotalPages,
  selectFavoriteIds,
  selectFavoriteItems,
  selectIsFavorite,
  selectHistoryById,
  selectCollectionNames,
  selectCollectionCount,
  selectCollectionById,
  selectActiveEnvironment,
  selectEnvironmentNames,
  selectEnvironmentCount,
} from '../selectors';
import type { HistoryItem, Collection, Environment } from '@/types';

// Mock data
const mockHistoryItems: HistoryItem[] = [
  {
    id: 'history-1',
    request: {
      id: 'req-1',
      type: 'http',
      name: 'Test Request 1',
      method: 'GET',
      url: 'https://api.example.com/users',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    },
    response: {
      id: 'res-1',
      requestId: 'req-1',
      status: 200,
      statusText: 'OK',
      headers: {},
      body: '{}',
      time: 100,
      size: 2,
      timestamp: Date.now() - 1000,
    },
    timestamp: Date.now() - 1000,
  },
  {
    id: 'history-2',
    request: {
      id: 'req-2',
      type: 'http',
      name: 'Test Request 2',
      method: 'POST',
      url: 'https://api.example.com/users',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    },
    response: {
      id: 'res-2',
      requestId: 'req-2',
      status: 201,
      statusText: 'Created',
      headers: {},
      body: '{}',
      time: 150,
      size: 2,
      timestamp: Date.now() - 2000,
    },
    timestamp: Date.now() - 2000,
  },
  {
    id: 'history-3',
    request: {
      id: 'req-3',
      type: 'http',
      name: 'Test Request 3',
      method: 'DELETE',
      url: 'https://api.example.com/users/1',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
    },
    timestamp: Date.now() - 3000,
  },
];

const mockCollections: Collection[] = [
  {
    id: 'col-1',
    name: 'API Tests',
    items: [],
  },
  {
    id: 'col-2',
    name: 'User Endpoints',
    items: [
      {
        id: 'item-1',
        name: 'Get Users',
        type: 'request',
      },
    ],
  },
];

const mockEnvironments: Environment[] = [
  {
    id: 'env-1',
    name: 'Development',
    variables: [{ id: 'var-1', key: 'BASE_URL', value: 'http://localhost:3000', enabled: true }],
  },
  {
    id: 'env-2',
    name: 'Production',
    variables: [{ id: 'var-2', key: 'BASE_URL', value: 'https://api.example.com', enabled: true }],
  },
];

describe('History Selectors', () => {
  const historyState = {
    history: mockHistoryItems,
    favorites: ['history-1', 'history-3'],
  };

  describe('selectHistoryPage', () => {
    it('should return correct page of items', () => {
      const page0 = selectHistoryPage(0, 2)(historyState);
      expect(page0).toHaveLength(2);
      expect(page0[0]?.id).toBe('history-1');
      expect(page0[1]?.id).toBe('history-2');

      const page1 = selectHistoryPage(1, 2)(historyState);
      expect(page1).toHaveLength(1);
      expect(page1[0]?.id).toBe('history-3');
    });

    it('should return empty array for out of bounds page', () => {
      const page = selectHistoryPage(10, 2)(historyState);
      expect(page).toHaveLength(0);
    });
  });

  describe('selectHistoryCount', () => {
    it('should return total history count', () => {
      expect(selectHistoryCount(historyState)).toBe(3);
    });

    it('should return 0 for empty history', () => {
      expect(selectHistoryCount({ history: [], favorites: [] })).toBe(0);
    });
  });

  describe('selectHistoryTotalPages', () => {
    it('should calculate total pages correctly', () => {
      expect(selectHistoryTotalPages(2)(historyState)).toBe(2);
      expect(selectHistoryTotalPages(1)(historyState)).toBe(3);
      expect(selectHistoryTotalPages(10)(historyState)).toBe(1);
    });

    it('should return 0 for empty history', () => {
      expect(selectHistoryTotalPages(10)({ history: [], favorites: [] })).toBe(0);
    });
  });

  describe('selectFavoriteIds', () => {
    it('should return favorite IDs', () => {
      const favorites = selectFavoriteIds(historyState);
      expect(favorites).toEqual(['history-1', 'history-3']);
    });
  });

  describe('selectFavoriteItems', () => {
    it('should return favorite items', () => {
      const favorites = selectFavoriteItems(historyState);
      expect(favorites).toHaveLength(2);
      expect(favorites[0]?.id).toBe('history-1');
      expect(favorites[1]?.id).toBe('history-3');
    });

    it('should return empty array when no favorites', () => {
      const state = { ...historyState, favorites: [] };
      expect(selectFavoriteItems(state)).toHaveLength(0);
    });
  });

  describe('selectIsFavorite', () => {
    it('should return true for favorite items', () => {
      expect(selectIsFavorite('history-1')(historyState)).toBe(true);
      expect(selectIsFavorite('history-3')(historyState)).toBe(true);
    });

    it('should return false for non-favorite items', () => {
      expect(selectIsFavorite('history-2')(historyState)).toBe(false);
      expect(selectIsFavorite('nonexistent')(historyState)).toBe(false);
    });
  });

  describe('selectHistoryById', () => {
    it('should find history item by ID', () => {
      const item = selectHistoryById('history-2')(historyState);
      expect(item).toBeDefined();
      expect(item?.id).toBe('history-2');
    });

    it('should return undefined for non-existent ID', () => {
      expect(selectHistoryById('nonexistent')(historyState)).toBeUndefined();
    });
  });
});

describe('Collection Selectors', () => {
  const collectionState = {
    collections: mockCollections,
  };

  describe('selectCollectionNames', () => {
    it('should return collection names with IDs', () => {
      const names = selectCollectionNames(collectionState);
      expect(names).toHaveLength(2);
      expect(names[0]).toEqual({ id: 'col-1', name: 'API Tests' });
      expect(names[1]).toEqual({ id: 'col-2', name: 'User Endpoints' });
    });
  });

  describe('selectCollectionCount', () => {
    it('should return total collection count', () => {
      expect(selectCollectionCount(collectionState)).toBe(2);
    });
  });

  describe('selectCollectionById', () => {
    it('should find collection by ID', () => {
      const collection = selectCollectionById('col-2')(collectionState);
      expect(collection).toBeDefined();
      expect(collection?.name).toBe('User Endpoints');
    });

    it('should return undefined for non-existent ID', () => {
      expect(selectCollectionById('nonexistent')(collectionState)).toBeUndefined();
    });
  });
});

describe('Environment Selectors', () => {
  const environmentState = {
    environments: mockEnvironments,
    activeEnvironmentId: 'env-1',
  };

  describe('selectActiveEnvironment', () => {
    it('should return active environment', () => {
      const active = selectActiveEnvironment(environmentState);
      expect(active).toBeDefined();
      expect(active?.name).toBe('Development');
    });

    it('should return undefined when no active environment', () => {
      const state = { ...environmentState, activeEnvironmentId: null };
      expect(selectActiveEnvironment(state)).toBeUndefined();
    });
  });

  describe('selectEnvironmentNames', () => {
    it('should return environment names with IDs', () => {
      const names = selectEnvironmentNames(environmentState);
      expect(names).toHaveLength(2);
      expect(names[0]).toEqual({ id: 'env-1', name: 'Development' });
      expect(names[1]).toEqual({ id: 'env-2', name: 'Production' });
    });
  });

  describe('selectEnvironmentCount', () => {
    it('should return total environment count', () => {
      expect(selectEnvironmentCount(environmentState)).toBe(2);
    });
  });
});
