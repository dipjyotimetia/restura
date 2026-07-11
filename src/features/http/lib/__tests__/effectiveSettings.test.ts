import { describe, expect, it } from 'vitest';
import { resolveEffectiveSettings } from '../effectiveSettings';
import type { AppSettings, RequestSettings } from '@/types';

const globalSettings = {
  proxy: {
    enabled: true,
    type: 'http',
    host: 'proxy.example.test',
    port: 8080,
    auth: { username: 'restura', password: { kind: 'handle', id: 'proxy-secret' } },
  },
  defaultTimeout: 30_000,
  followRedirects: true,
  maxRedirects: 10,
  verifySsl: true,
  autoSaveHistory: true,
  maxHistoryItems: 100,
  theme: 'dark',
  layoutOrientation: 'horizontal',
  followOriginalMethod: false,
  disableCookieJar: false,
  minTlsVersion: 'TLSv1.2',
} as unknown as AppSettings;

describe('resolveEffectiveSettings', () => {
  it('inherits omitted request fields while preserving explicit overrides', () => {
    const requestSettings = {
      timeout: 5_000,
      followRedirects: false,
      disableCookieJar: true,
    } as RequestSettings;

    expect(resolveEffectiveSettings(requestSettings, globalSettings)).toEqual({
      timeout: 5_000,
      followRedirects: false,
      maxRedirects: 10,
      verifySsl: true,
      proxy: globalSettings.proxy,
      followOriginalMethod: false,
      disableCookieJar: true,
      minTlsVersion: 'TLSv1.2',
    });
  });
});
