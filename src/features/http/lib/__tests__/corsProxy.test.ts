import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shouldUseCorsProxy, isCorsError, getCorsProxyStatus } from '../proxyHelper';
import { AppSettings } from '@/types';

// Mock the platform module
vi.mock('@/lib/shared/platform', () => ({
  isElectron: vi.fn(() => false),
  getElectronAPI: vi.fn(() => null),
}));

import { isElectron } from '@/lib/shared/platform';

const mockIsElectron = vi.mocked(isElectron);

describe('shouldUseCorsProxy', () => {
  const defaultSettings: AppSettings = {
    proxy: {
      enabled: false,
      type: 'http',
      host: '',
      port: 8080,
    },
    defaultTimeout: 30000,
    followRedirects: true,
    maxRedirects: 10,
    verifySsl: true,
    autoSaveHistory: true,
    maxHistoryItems: 100,
    theme: 'dark',
    layoutOrientation: 'vertical',
    corsProxy: {
      enabled: true,
      autoDetect: true,
    },
  };

  beforeEach(() => {
    mockIsElectron.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should return true when in browser mode and CORS proxy is enabled', () => {
    expect(shouldUseCorsProxy(defaultSettings)).toBe(true);
  });

  it('should return false when in Electron mode', () => {
    mockIsElectron.mockReturnValue(true);
    expect(shouldUseCorsProxy(defaultSettings)).toBe(false);
  });

  it('should return false when CORS proxy is disabled', () => {
    const settings = {
      ...defaultSettings,
      corsProxy: {
        enabled: false,
        autoDetect: true,
      },
    };
    expect(shouldUseCorsProxy(settings)).toBe(false);
  });

  it('should default to true when corsProxy is undefined', () => {
    const settings = {
      ...defaultSettings,
      corsProxy: undefined as unknown as AppSettings['corsProxy'],
    };
    expect(shouldUseCorsProxy(settings)).toBe(true);
  });
});

describe('isCorsError', () => {
  it('should return true for CORS error message', () => {
    const error = new Error('CORS error: blocked by policy');
    expect(isCorsError(error)).toBe(true);
  });

  it('should return true for cross-origin error message', () => {
    const error = new Error('Cross-Origin Request Blocked');
    expect(isCorsError(error)).toBe(true);
  });

  it('should return true for network error message', () => {
    const error = new Error('Network Error');
    expect(isCorsError(error)).toBe(true);
  });

  it('should return true for failed to fetch message', () => {
    const error = new Error('Failed to fetch');
    expect(isCorsError(error)).toBe(true);
  });

  it('should return false for other errors', () => {
    const error = new Error('Server returned 500');
    expect(isCorsError(error)).toBe(false);
  });

  it('should return false for non-Error objects', () => {
    expect(isCorsError('string error')).toBe(false);
    expect(isCorsError(null)).toBe(false);
    expect(isCorsError(undefined)).toBe(false);
  });
});

describe('getCorsProxyStatus', () => {
  const defaultSettings: AppSettings = {
    proxy: {
      enabled: false,
      type: 'http',
      host: '',
      port: 8080,
    },
    defaultTimeout: 30000,
    followRedirects: true,
    maxRedirects: 10,
    verifySsl: true,
    autoSaveHistory: true,
    maxHistoryItems: 100,
    theme: 'dark',
    layoutOrientation: 'vertical',
    corsProxy: {
      enabled: true,
      autoDetect: true,
    },
  };

  beforeEach(() => {
    mockIsElectron.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should return active status when CORS proxy is enabled in browser', () => {
    const status = getCorsProxyStatus(defaultSettings);
    expect(status.active).toBe(true);
    expect(status.message).toContain('CORS proxy active');
  });

  it('should return inactive status when in Electron mode', () => {
    mockIsElectron.mockReturnValue(true);
    const status = getCorsProxyStatus(defaultSettings);
    expect(status.active).toBe(false);
    expect(status.message).toContain('Desktop mode');
  });

  it('should return warning when CORS proxy is disabled in browser', () => {
    const settings = {
      ...defaultSettings,
      corsProxy: {
        enabled: false,
        autoDetect: true,
      },
    };
    const status = getCorsProxyStatus(settings);
    expect(status.active).toBe(false);
    expect(status.message).toContain('CORS restrictions');
  });
});
