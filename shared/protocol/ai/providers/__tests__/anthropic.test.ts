import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SseParser } from '@shared/protocol/sse-parser';
import { anthropicModule } from '@shared/protocol/ai/providers/anthropic';
import type { ChatStreamEvent } from '@shared/protocol/ai/types';

function load(name: string): Uint8Array {
  return new TextEncoder().encode(readFileSync(join(__dirname, '..', '__fixtures__', name), 'utf8'));
}

function decodeFixture(name: string, model = 'claude-sonnet-4-6'): ChatStreamEvent[] {
  const decoder = anthropicModule.createDecoder(model);
  const parser = new SseParser();
  const events: ChatStreamEvent[] = [];
  for (const e of parser.feed(load(name))) events.push(...decoder.feed(e.data, e.event));
  for (const e of parser.flush()) events.push(...decoder.feed(e.data, e.event));
  events.push(...decoder.flush());
  return events;
}

describe('anthropic decoder', () => {
  it('reconstructs text from content_block_delta events', () => {
    const events = decodeFixture('anthropic-explain.sse.txt');
    const text = events.filter((e): e is Extract<ChatStreamEvent, { type: 'delta' }> => e.type === 'delta').map((d) => d.text).join('');
    expect(text).toBe('The request failed.');
  });

  it('aggregates input_tokens from message_start and output_tokens from message_delta', () => {
    const events = decodeFixture('anthropic-explain.sse.txt');
    const usage = events.find((e): e is Extract<ChatStreamEvent, { type: 'usage' }> => e.type === 'usage');
    expect(usage?.usage.promptTokens).toBe(42);
    expect(usage?.usage.completionTokens).toBe(3);
    expect(usage?.usage.estimatedCostUSD).toBeGreaterThan(0);
  });

  it('emits a provider error for error events', () => {
    const events = decodeFixture('anthropic-error-malformed.sse.txt');
    const err = events.find((e): e is Extract<ChatStreamEvent, { type: 'error' }> => e.type === 'error');
    expect(err?.code).toBe('provider');
    expect(err?.message).toContain('Overloaded');
  });

  it('ends with done', () => {
    const events = decodeFixture('anthropic-explain.sse.txt');
    expect(events.at(-1)?.type).toBe('done');
  });
});
