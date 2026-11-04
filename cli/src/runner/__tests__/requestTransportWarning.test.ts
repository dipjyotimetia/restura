import type { HttpRequest, RequestSettingsOverride } from '@shared/types';
import { describe, expect, it } from 'vitest';
import type { LoadedRequest } from '../collectionLoader';
import { requestTransportWarning } from '../runner';

function http(settings?: RequestSettingsOverride): LoadedRequest {
  const request: HttpRequest = {
    id: 'r',
    name: 'R',
    type: 'http',
    method: 'GET',
    url: 'https://example.com',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...(settings ? { settings } : {}),
  };
  return { relativePath: 'r.json', folderPath: [], type: 'http', request };
}

const ENV = { HTTPS_PROXY: 'http://proxy.internal:3128' };

describe('requestTransportWarning', () => {
  it('warns that requests with their own TLS options skip the env proxy', () => {
    const warning = requestTransportWarning(
      [http({ verifySsl: false }), http({ caCert: { pem: 'x' } }), http()],
      ENV,
      undefined
    );
    expect(warning).toMatch(/2 requests set their own TLS options/);
    expect(warning).toMatch(/HTTPS_PROXY/);
  });

  it('stays quiet with --proxy, without an env proxy, or for default settings', () => {
    expect(
      requestTransportWarning([http({ verifySsl: false })], ENV, 'http://p:1')
    ).toBeUndefined();
    expect(requestTransportWarning([http({ verifySsl: false })], {}, undefined)).toBeUndefined();
    expect(requestTransportWarning([http({ verifySsl: true })], ENV, undefined)).toBeUndefined();
  });
});
