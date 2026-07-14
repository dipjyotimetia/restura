import { describe, expect, it } from 'vitest';
import type { AiLabProviderConfig } from '../../types';
import { completeLlm, specFor } from '../llmClient';

const CLOUD: AiLabProviderConfig = {
  id: 'p1',
  provider: 'openai',
  label: 'OpenAI',
  apiKeyHandleId: 'handle-1',
  pricingKnown: true,
  isLocal: false,
  models: ['gpt-4o'],
  createdAt: 0,
};

const LOCAL: AiLabProviderConfig = {
  id: 'p2',
  provider: 'ollama',
  label: 'Ollama',
  baseUrl: 'http://localhost:11434',
  pricingKnown: false,
  isLocal: true,
  models: [],
  createdAt: 0,
};

const MSGS = [{ role: 'user' as const, content: 'hi' }];

describe('specFor', () => {
  it('always sets rawMode true and includes the api key handle for cloud providers', () => {
    const spec = specFor(CLOUD, 'gpt-4o', MSGS);
    expect(spec.rawMode).toBe(true);
    expect(spec.apiKeyHandleId).toBe('handle-1');
    expect(spec.baseUrlOverride).toBeUndefined();
    expect(spec.model).toBe('gpt-4o');
  });

  it('includes baseUrlOverride and omits the key for a keyless local provider', () => {
    const spec = specFor(LOCAL, 'llama3.2', MSGS);
    expect(spec.baseUrlOverride).toBe('http://localhost:11434');
    expect(spec.apiKeyHandleId).toBeUndefined();
  });

  it('passes through tools and maxOutputTokens options', () => {
    const tools = [{ name: 't', description: 'd', inputSchema: { type: 'object' } }];
    const spec = specFor(CLOUD, 'gpt-4o', MSGS, { tools, maxOutputTokens: 512 });
    expect(spec.tools).toBe(tools);
    expect(spec.maxOutputTokens).toBe(512);
  });
});

describe('completeLlm (web guard)', () => {
  it('rejects when not running in Electron (no window.electron bridge)', async () => {
    await expect(completeLlm(specFor(CLOUD, 'gpt-4o', MSGS))).rejects.toThrow(/desktop app/i);
  });
});
