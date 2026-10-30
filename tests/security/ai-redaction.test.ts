// tests/security/ai-redaction.test.ts

import { executeAiChat } from '@shared/protocol/ai/ai-proxy';
import { listModels } from '@shared/protocol/ai/model-discovery';
import {
  detectUnredactedSecrets,
  effectiveRawMode,
  redactBody,
  redactHeaders,
} from '@shared/protocol/ai/redaction';
import { describe, expect, it } from 'vitest';
import { specFor } from '@/features/ai-lab/lib/llmClient';
import type { AiLabProviderConfig } from '@/features/ai-lab/types';

const JWT_BODY = (s: string) => `{"token":"${s}"}`;

function randomJwt(): string {
  const part = (n: number) =>
    Array.from(
      { length: n },
      () =>
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'[
          Math.floor(Math.random() * 64)
        ] ?? 'A'
    ).join('');
  return `eyJ${part(20)}.${part(60)}.${part(30)}`;
}

describe('redaction property tests', () => {
  it('100 random JWTs are all stripped', () => {
    for (let i = 0; i < 100; i++) {
      const jwt = randomJwt();
      const out = redactBody(JWT_BODY(jwt), 'default');
      expect(out).not.toContain(jwt);
    }
  });

  it('100 random Bearer tokens (sk-… style) are all stripped', () => {
    for (let i = 0; i < 100; i++) {
      const tok = `sk-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
      const line = `Authorization: Bearer ${tok}`;
      const out = redactBody(line, 'default');
      expect(out).not.toContain(tok);
    }
  });

  it('case variants of Authorization header are caught', () => {
    for (const name of ['authorization', 'Authorization', 'AUTHORIZATION', 'AuThOrIzAtIoN']) {
      const out = redactHeaders({ [name]: 'Bearer secret' }, 'default');
      expect(out[name]).toBe('[REDACTED]');
    }
  });

  it('detectUnredactedSecrets catches anything redactBody would have removed', () => {
    for (let i = 0; i < 50; i++) {
      const jwt = randomJwt();
      expect(detectUnredactedSecrets(JWT_BODY(jwt))).toBe(true);
    }
  });

  it('redactBody output never trips detectUnredactedSecrets', () => {
    for (let i = 0; i < 50; i++) {
      const jwt = randomJwt();
      const redacted = redactBody(JWT_BODY(jwt), 'default');
      expect(detectUnredactedSecrets(redacted)).toBe(false);
    }
  });
});

describe('prefix-recognizable provider/cloud tokens (no key name, no Bearer)', () => {
  // Synthetic, non-real tokens built from a prefix + filler at runtime. Assembling
  // them by concatenation means no contiguous secret-shaped literal exists in the
  // source, which avoids secret-scanning false positives (these are fixtures, not
  // real credentials) while the runtime values still match the redaction patterns.
  const FILL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const SECRETS = [
    'sk-' + FILL.slice(0, 32), // OpenAI
    'sk-ant-api03-' + FILL.slice(0, 30), // Anthropic
    'sk-or-v1-' + FILL.slice(0, 30), // OpenRouter
    'AKIA' + FILL.slice(0, 16), // AWS access key id
    'ghp_' + FILL.slice(0, 36), // GitHub PAT
    'github_pat_' + FILL.slice(0, 30), // GitHub fine-grained
    'xoxb-' + FILL.slice(0, 20), // Slack
    'AIza' + FILL.slice(0, 35), // Google API key
  ];

  it('strips each bare token from a body that uses an unrecognized key name', () => {
    for (const secret of SECRETS) {
      // Key is "value" — NOT api_key/secret/password/token, so only the
      // prefix-based patterns can catch it.
      const out = redactBody(`{"value":"${secret}"}`, 'default');
      expect(out, `leaked: ${secret}`).not.toContain(secret);
    }
  });

  it('detectUnredactedSecrets flags each bare token', () => {
    for (const secret of SECRETS) {
      expect(detectUnredactedSecrets(`{"value":"${secret}"}`), `missed: ${secret}`).toBe(true);
    }
  });

  it('redacts non-x- credential headers (api-key, private-token) but keeps www-authenticate', () => {
    const out = redactHeaders(
      {
        'api-key': 'secret-azure-key-value',
        'Private-Token': 'glpat-xxxxxxxxxxxx',
        'WWW-Authenticate': 'Bearer realm="api"',
      },
      'default'
    );
    expect(out['api-key']).toBe('[REDACTED]');
    expect(out['Private-Token']).toBe('[REDACTED]');
    // Challenge header is diagnostic, not a credential — must survive.
    expect(out['WWW-Authenticate']).toBe('Bearer realm="api"');
  });
});

describe('AI Lab secret check follows provider kind (#1028)', () => {
  const CAPTURED = `{"value":"${'sk-' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'}"}`;
  const mk = (id: string, provider: AiLabProviderConfig['provider'], isLocal: boolean) =>
    ({
      id,
      provider,
      label: 'p',
      pricingKnown: false,
      isLocal,
      models: [],
      createdAt: 0,
    }) as AiLabProviderConfig;
  const cloud = mk('c', 'openai', false);
  const ollama = mk('l', 'ollama', true);
  const compat = mk('o', 'openai-compatible', true);
  const msgs = [{ role: 'user' as const, content: CAPTURED }];

  // Run the real orchestrator; the fetcher throws so a call that passes the
  // guard surfaces as a `network` error instead of touching the wire.
  async function firstEvent(spec: ReturnType<typeof specFor>) {
    const fetcher = (async () => {
      throw new Error('upstream reached');
    }) as never;
    for await (const ev of executeAiChat(
      { ...spec, apiKeyHandleId: '', signal: new AbortController().signal } as never,
      fetcher,
      async () => undefined
    )) {
      return ev;
    }
    return undefined;
  }

  it('cloud kinds keep the secret check on, so captured secrets are refused', async () => {
    const spec = specFor(cloud, 'gpt-4o', msgs);
    expect(spec.rawMode).toBe(false);
    expect(await firstEvent(spec)).toMatchObject({ type: 'error', code: 'guard' });
  });

  it('the renderer never decides locality: rawMode is the explicit override only', () => {
    for (const cfg of [cloud, ollama, compat]) {
      expect(specFor(cfg, 'm', msgs).rawMode).toBe(false);
    }
  });

  it('local kinds skip the check only when the pinned address is loopback or RFC1918', () => {
    for (const kind of ['ollama', 'openai-compatible'] as const) {
      for (const ip of ['127.0.0.1', '::1', '10.0.0.5', '172.16.4.2', '192.168.1.9']) {
        expect(effectiveRawMode(false, kind, ip)).toBe(true);
      }
      // A "local" kind pointed at a public host (e.g. api.groq.com) is a cloud call.
      for (const ip of ['104.18.2.1', '8.8.8.8', '2606:4700::1']) {
        expect(effectiveRawMode(false, kind, ip)).toBe(false);
      }
    }
  });

  it('cloud kinds and the explicit override ignore the address', () => {
    expect(effectiveRawMode(false, 'openai', '127.0.0.1')).toBe(false);
    expect(effectiveRawMode(true, 'openai-compatible', '8.8.8.8')).toBe(true);
  });

  it('a local kind at a public address refuses captured secrets unless overridden', async () => {
    const spec = specFor(compat, 'm', msgs);
    const publicSpec = {
      ...spec,
      rawMode: effectiveRawMode(spec.rawMode === true, spec.provider, '104.18.2.1'),
    };
    expect(await firstEvent(publicSpec)).toMatchObject({ type: 'error', code: 'guard' });
    const lanSpec = {
      ...spec,
      rawMode: effectiveRawMode(spec.rawMode === true, spec.provider, '192.168.1.9'),
    };
    expect(await firstEvent(lanSpec)).toMatchObject({ type: 'error', code: 'network' });
  });

  it('the visible per-suite override sends unredacted to cloud', async () => {
    const spec = specFor(cloud, 'gpt-4o', msgs, { sendUnredactedToCloud: true });
    expect(spec.rawMode).toBe(true);
    expect(await firstEvent(spec)).toMatchObject({ type: 'error', code: 'network' });
  });
});

describe('provider error bodies never return the resolved key (ADR-0007)', () => {
  // Deliberately not a recognisable token shape, so only literal removal can catch it.
  const KEY = 'zq_9f8a7b6c5d4e3f2a1b0c';
  const echo = (status: number) =>
    (async () => ({
      status,
      statusText: 'Unauthorized',
      headers: {},
      contentLengthHeader: null,
      text: async () =>
        `{"error":"bad key","echo":{"Authorization":"Bearer ${KEY}","x-api-key":"${KEY}"}}`,
    })) as never;

  it('chat: the error event omits the key', async () => {
    const events: unknown[] = [];
    for await (const ev of executeAiChat(
      {
        provider: 'openai',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        apiKeyHandleId: 'h',
        rawMode: false,
        signal: new AbortController().signal,
      } as never,
      echo(401),
      async () => KEY
    )) {
      events.push(ev);
    }
    const error = events.find((e) => (e as { type: string }).type === 'error') as {
      message: string;
    };
    expect(error.message).toContain('Provider 401');
    expect(error.message).not.toContain(KEY);
  });

  it('discovery: the thrown error omits the key', async () => {
    const err = await listModels({
      provider: 'openai',
      baseUrl: 'https://api.example',
      apiKey: KEY,
      fetcher: echo(401),
    }).catch((e: Error) => e);
    expect((err as Error).message).toContain('Model discovery failed (401)');
    expect((err as Error).message).not.toContain(KEY);
  });
});
