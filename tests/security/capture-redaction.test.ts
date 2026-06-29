/**
 * Security regression: a captured session must never leak plaintext secrets
 * into any export path (HAR or OpenCollection). Covers the denied-header,
 * cookie, JWT-body, and prefixed-provider-token classes.
 */
import { describe, expect, it } from 'vitest';
import { redactExchange } from '@shared/capture/secret-extractor';
import { sessionToHar } from '@shared/capture/to-har';
import { sessionToOpenCollection } from '@shared/capture/to-opencollection';
import type { CaptureSession } from '@shared/capture/types';

const SECRETS = {
  bearer: 'Bearer abcdEFGH1234567890token',
  cookie: 'session=hunter2hunter2hunter2',
  jwt: 'eyJhbGciOiAns123.eyJzdWIiOiAns456.signatureZZZxyz',
  openai: 'sk-proj-ABCDEFGHIJKLMNOPQRSTUV',
  queryToken: 'queryAccessTokenSECRET123',
  frameJwt: 'eyJ0eXAiOiAns999.eyJzdWIiOiAns888.frameSigSECRET',
  locationCode: 'oauthLocationCODEsecret',
  refererToken: 'refererAccessTokenSECRET',
};

function session(): CaptureSession {
  return {
    id: 's',
    createdAt: 0,
    exchanges: [
      {
        id: '1',
        protocol: 'rest',
        method: 'GET',
        url: `https://api.example.com/me?access_token=${SECRETS.queryToken}&page=1`,
        startedAt: 0,
        request: {
          headers: [
            { name: 'Authorization', value: SECRETS.bearer },
            { name: 'Cookie', value: SECRETS.cookie },
            { name: 'X-Api-Key', value: 'topsecretapikeyvalue' },
            // Token in a NON-denylisted header value (referrer-leak vector).
            {
              name: 'Referer',
              value: `https://app.example.com/p?access_token=${SECRETS.refererToken}&t=1`,
            },
          ],
        },
        response: {
          status: 302,
          headers: [
            { name: 'Set-Cookie', value: SECRETS.cookie },
            // OAuth code in a redirect Location header (non-denylisted name).
            {
              name: 'Location',
              value: `https://app.example.com/cb?code=${SECRETS.locationCode}&state=x`,
            },
          ],
          body: { text: `{"jwt":"${SECRETS.jwt}","key":"${SECRETS.openai}"}` },
        },
      },
      {
        id: '2',
        protocol: 'websocket',
        method: 'GET',
        url: 'wss://api.example.com/socket',
        startedAt: 0,
        request: { headers: [] },
        frames: [
          {
            direction: 'received',
            payload: { base64: btoa(`{"auth":"${SECRETS.frameJwt}"}`) },
            at: 0,
          },
        ],
      },
    ],
  };
}

function redactedSession(): CaptureSession {
  const s = session();
  return { ...s, exchanges: s.exchanges.map((e) => redactExchange(e).exchange) };
}

describe('capture export redaction', () => {
  it('redactExchange records the secret-bearing headers', () => {
    const { secrets } = redactExchange(session().exchanges[0]!);
    const names = secrets.map((s) => s.name);
    expect(names).toContain('authorization');
    expect(names).toContain('cookie');
    expect(names).toContain('xApiKey');
  });

  it('leaks no plaintext secret into the OpenCollection export', () => {
    const json = JSON.stringify(sessionToOpenCollection(redactedSession()));
    for (const secret of Object.values(SECRETS)) {
      expect(json).not.toContain(secret);
    }
  });

  it('leaks no plaintext secret into the HAR export', () => {
    const json = JSON.stringify(sessionToHar(redactedSession()));
    for (const secret of Object.values(SECRETS)) {
      expect(json).not.toContain(secret);
    }
  });
});
