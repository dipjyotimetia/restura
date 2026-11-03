import { describe, expect, it } from 'vitest';
import type { RequestSettings } from '@/types';
import { applySettingsPatch } from '../settingsPatch';

const base: RequestSettings = {
  timeout: 1000,
  followRedirects: true,
  maxRedirects: 5,
  verifySsl: true,
  caCert: { pem: 'PEM' },
  minTlsVersion: 'TLSv1.2',
};

describe('applySettingsPatch', () => {
  it('sets supplied keys and leaves absent ones alone', () => {
    expect(applySettingsPatch(base, { timeout: 5, httpVersion: 'http2' })).toEqual({
      ...base,
      timeout: 5,
      httpVersion: 'http2',
    });
  });

  it('removes a clearable key given as undefined, without mutating the input', () => {
    const next = applySettingsPatch(base, { caCert: undefined, minTlsVersion: undefined });
    expect('caCert' in next).toBe(false);
    expect('minTlsVersion' in next).toBe(false);
    expect(next.timeout).toBe(1000);
    expect(base.caCert).toEqual({ pem: 'PEM' });
  });

  it('works on a partial override', () => {
    expect(
      applySettingsPatch({ clientCert: { format: 'pem' } }, { clientCert: undefined })
    ).toEqual({});
  });
});
