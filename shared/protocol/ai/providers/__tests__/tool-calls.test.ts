import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SseParser } from '@shared/protocol/sse-parser';
import { anthropicModule } from '@shared/protocol/ai/providers/anthropic';
import { openaiModule } from '@shared/protocol/ai/providers/openai';
import type { ChatStreamEvent } from '@shared/protocol/ai/types';
import type { ProviderModule } from '@shared/protocol/ai/providers/types';

function load(name: string): Uint8Array {
  return new TextEncoder().encode(readFileSync(join(__dirname, '..', '__fixtures__', name), 'utf8'));
}

function decode(mod: ProviderModule, name: string, model: string): ChatStreamEvent[] {
  const decoder = mod.createDecoder(model);
  const parser = new SseParser();
  const events: ChatStreamEvent[] = [];
  for (const e of parser.feed(load(name))) events.push(...decoder.feed(e.data, e.event));
  for (const e of parser.flush()) events.push(...decoder.feed(e.data, e.event));
  events.push(...decoder.flush());
  return events;
}

type ToolCall = Extract<ChatStreamEvent, { type: 'tool_call' }>;

describe('anthropic tool_use decoding', () => {
  it('reconstructs a tool call from streamed input_json_delta fragments', () => {
    const events = decode(anthropicModule, 'anthropic-tool-use.sse.txt', 'claude-sonnet-4-6');
    const call = events.find((e): e is ToolCall => e.type === 'tool_call');
    expect(call).toBeDefined();
    expect(call?.id).toBe('toolu_01');
    expect(call?.name).toBe('create_http_request');
    expect(JSON.parse(call!.input)).toEqual({ method: 'GET', url: 'https://api.example/users' });
  });
});

describe('openai tool_calls decoding', () => {
  it('reconstructs a tool call from streamed argument fragments', () => {
    const events = decode(openaiModule, 'openai-tool-call.sse.txt', 'gpt-4o');
    const call = events.find((e): e is ToolCall => e.type === 'tool_call');
    expect(call).toBeDefined();
    expect(call?.id).toBe('call_01');
    expect(call?.name).toBe('create_http_request');
    expect(JSON.parse(call!.input)).toEqual({ method: 'GET', url: 'https://api.example/users' });
  });
});
