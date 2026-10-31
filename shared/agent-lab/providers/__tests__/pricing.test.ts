import { describe, expect, it } from 'vitest';
import type { Fetcher } from '../../../protocol/types';
import { AnthropicMessagesAdapter } from '../anthropic-messages';
import { OpenAiResponsesAdapter } from '../openai-responses';
import { knownCostUSD, resolveModelPrice } from '../pricing';

function jsonFetcher(body: unknown): Fetcher {
  return async () => ({
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: null,
    contentLengthHeader: null,
    async text() {
      return JSON.stringify(body);
    },
  });
}

const context = {
  async resolveCredential() {
    return 'test-key';
  },
};

function request(providerId: string, model: string) {
  return {
    model: { providerId, model, credential: { source: 'env' as const, name: 'KEY' } },
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
  };
}

describe('resolveModelPrice', () => {
  it('reads the shared provider price tables and prefers manifest overrides', () => {
    expect(resolveModelPrice('openai.responses', 'gpt-5.4-mini')?.inputUSDPerMTok).toBe(0.75);
    expect(resolveModelPrice('anthropic.messages', 'claude-haiku-4-5')?.outputUSDPerMTok).toBe(5);
    expect(resolveModelPrice('openai.responses', 'gpt-test')).toBeUndefined();
    expect(
      resolveModelPrice('openai.responses', 'gpt-test', {
        'gpt-test': { inputUSDPerMTok: 1, outputUSDPerMTok: 2 },
      })
    ).toEqual({ inputUSDPerMTok: 1, outputUSDPerMTok: 2 });
  });
});

describe('knownCostUSD', () => {
  const noCachePrice = { inputUSDPerMTok: 1, outputUSDPerMTok: 2 };

  it('prices uncached tokens', () => {
    expect(knownCostUSD(noCachePrice, { input: 1_000_000, output: 500_000 })).toBeCloseTo(2);
  });

  it('is unknown, not mispriced, for unpriced models and for cached tokens without a cached price', () => {
    expect(knownCostUSD(undefined, { input: 1, output: 1 })).toBeUndefined();
    expect(knownCostUSD(noCachePrice, { input: 1, output: 1, cacheRead: 10 })).toBeUndefined();
    expect(knownCostUSD(noCachePrice, { input: 1, output: 1, cacheWrite: 10 })).toBeUndefined();
    expect(
      knownCostUSD(
        { ...noCachePrice, cacheReadUSDPerMTok: 0.5 },
        { input: 0, output: 0, cacheRead: 1_000_000 }
      )
    ).toBeCloseTo(0.5);
  });
});

describe('provider adapters report costUSD', () => {
  it('prices an OpenAI response, billing cached input at the cache-read rate', async () => {
    const adapter = new OpenAiResponsesAdapter({
      fetcher: jsonFetcher({
        id: 'r1',
        output: [],
        usage: {
          input_tokens: 1_000,
          output_tokens: 500,
          input_tokens_details: { cached_tokens: 400 },
        },
      }),
    });

    const response = await adapter.generate(request('openai.responses', 'gpt-5.4-mini'), context);

    // 600 uncached * 0.75 + 400 cached * 0.075 + 500 out * 4.5, per million
    expect(response.costUSD).toBeCloseTo((600 * 0.75 + 400 * 0.075 + 500 * 4.5) / 1e6, 10);
  });

  it('leaves cost unset for an unpriced OpenAI model unless the manifest prices it', async () => {
    const fetcher = jsonFetcher({
      id: 'r1',
      output: [],
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    });

    const unpriced = await new OpenAiResponsesAdapter({ fetcher }).generate(
      request('openai.responses', 'gpt-test'),
      context
    );
    const overridden = await new OpenAiResponsesAdapter({
      fetcher,
      priceOverrides: { 'gpt-test': { inputUSDPerMTok: 1, outputUSDPerMTok: 3 } },
    }).generate(request('openai.responses', 'gpt-test'), context);

    expect(unpriced.costUSD).toBeUndefined();
    expect(overridden.costUSD).toBeCloseTo(4);
  });

  it('prices an Anthropic response including cache reads and writes', async () => {
    const adapter = new AnthropicMessagesAdapter({
      fetcher: jsonFetcher({
        id: 'm1',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 1_000,
          output_tokens: 500,
          cache_read_input_tokens: 2_000,
          cache_creation_input_tokens: 300,
        },
      }),
    });

    const response = await adapter.generate(
      request('anthropic.messages', 'claude-haiku-4-5'),
      context
    );

    expect(response.costUSD).toBeCloseTo(
      (1_000 * 1.0 + 2_000 * 0.1 + 300 * 1.25 + 500 * 5.0) / 1e6,
      10
    );
  });

  it('reports unknown cost when cached tokens have no cached price', async () => {
    const adapter = new AnthropicMessagesAdapter({
      fetcher: jsonFetcher({
        id: 'm1',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
      }),
      priceOverrides: { 'claude-test': { inputUSDPerMTok: 1, outputUSDPerMTok: 2 } },
    });

    const response = await adapter.generate(request('anthropic.messages', 'claude-test'), context);

    expect(response.costUSD).toBeUndefined();
  });
});
