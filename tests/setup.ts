import { afterEach, beforeAll, vi } from 'vitest';

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
      setItem: (key: string, value: string) => { store[key] = value.toString(); },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { store = {}; },
      get length() { return Object.keys(store).length; },
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
