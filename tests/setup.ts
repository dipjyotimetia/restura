import { afterEach, beforeAll, vi } from 'vitest';

// Dexie (IndexedDB) is not available in jsdom — mock the storage layer so
// Zustand persist middleware never fires real async I/O during unit tests.
// Without this, setState() triggers setItem() which fails post-teardown and
// produces EnvironmentTeardownError ("onUserConsoleLog" pending).
// dexie-storage.ts is already excluded from coverage (see vitest.config.ts).
// NOTE: factory must be self-contained — vi.mock() is hoisted before const declarations.
vi.mock('@/lib/shared/dexie-storage', () => {
  const noop = {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  };
  const f = () => noop;
  return {
    createDexieStorage: () => noop,
    dexieStorageAdapters: {
      collections: f,
      environments: f,
      history: f,
      settings: f,
      cookies: f,
      workflows: f,
      workflowExecutions: f,
      fileCollections: f,
      requestTabs: f,
      websocketConnections: f,
      sseConnections: f,
      mcpConnections: f,
      kafkaConnections: f,
      socketioConnections: f,
      console: f,
      graphqlSchemas: f,
      protoFiles: f,
      aiChat: f,
      globals: f,
    },
    checkDexieStorageHealth: async () => ({ available: false, healthy: false }),
    clearDexieStorage: async () => undefined,
    getDexieStorageStats: async () => ({
      totalRecords: 0,
      tables: {},
      estimatedSize: 0,
      formattedSize: '0 B',
    }),
    exportDexieData: async () => '{}',
    importDexieData: async () => undefined,
    secureDeleteRecord: async () => undefined,
  };
});

const isBrowser = typeof window !== 'undefined';

if (isBrowser) {
  const { cleanup } = await import('@testing-library/react');
  const { default: _jestDom } = await import('@testing-library/jest-dom/vitest');
  void _jestDom;

  afterEach(() => {
    cleanup();
  });

  const localStorageMock = (() => {
    let store: Record<string, string> = {};
    return {
      getItem: (key: string) => store[key] || null,
      setItem: (key: string, value: string) => {
        store[key] = value.toString();
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
      get length() {
        return Object.keys(store).length;
      },
      key: (index: number) => Object.keys(store)[index] || null,
    };
  })();

  Object.defineProperty(window, 'localStorage', { value: localStorageMock });

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));

  beforeAll(() => {
    localStorageMock.clear();
  });
}
