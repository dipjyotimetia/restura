import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openaiModule } from '@shared/protocol/ai/providers/openai';
import type { ChatStreamEvent } from '@shared/protocol/ai/types';
import { SseParser } from '@shared/protocol/sse-parser';
import { describe, expect, it } from 'vitest';

function loadFixture(name: string): Uint8Array {
  return new TextEncoder().encode(
    readFileSync(join(__dirname, '..', '__fixtures__', name), 'utf8')
  );
}

function decodeFixture(fixtureName: string, model = 'gpt-4o-mini'): ChatStreamEvent[] {
  const decoder = openaiModule.createDecoder(model);
  const parser = new SseParser();
  const events: ChatStreamEvent[] = [];
  for (const sseEvent of parser.feed(loadFixture(fixtureName))) {
    events.push(...decoder.feed(sseEvent.data, sseEvent.event));
  }
  for (const sseEvent of parser.flush()) {
    events.push(...decoder.feed(sseEvent.data, sseEvent.event));
  }
  events.push(...decoder.flush());
  return events;
}

describe('openai decoder', () => {
  it('decodes a happy-path chunked completion', () => {
    const events = decodeFixture('openai-explain.sse.txt');
    const deltas = events.filter(
      (e): e is Extract<ChatStreamEvent, { type: 'delta' }> => e.type === 'delta'
    );
    expect(deltas.map((d) => d.text).join('')).toBe('The request failed.');
    const usage = events.find(
      (e): e is Extract<ChatStreamEvent, { type: 'usage' }> => e.type === 'usage'
    );
    expect(usage?.usage.promptTokens).toBe(42);
    expect(usage?.usage.completionTokens).toBe(3);
    expect(usage?.usage.estimatedCostUSD).toBeGreaterThan(0);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('exposes a model list with pricing', () => {
    expect(openaiModule.models.length).toBeGreaterThan(0);
    for (const m of openaiModule.models) {
      expect(m.inputUSDPerMTok).toBeGreaterThan(0);
      expect(m.outputUSDPerMTok).toBeGreaterThan(0);
    }
  });

  it('emits done when the stream ends with finish_reason but no [DONE] sentinel', () => {
    // Some OpenAI-compatible gateways/proxies omit the trailing `data: [DONE]`.
    // A non-null finish_reason must still terminate the stream so the renderer
    // finalizes the message instead of leaving it stuck "streaming".
    const decoder = openaiModule.createDecoder('gpt-4o-mini');
    const events = [
      ...decoder.feed('{"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}'),
      ...decoder.feed('{"choices":[{"delta":{},"finish_reason":"stop"}]}'),
      ...decoder.flush(),
    ];
    expect(events.some((e) => e.type === 'delta' && e.text === 'hi')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });
});
