import { describe, expect, it } from 'vitest';
import { buildEvalFile, EvalFileSchema } from '../evalFile';

const source = {
  name: 'Support replies',
  prompt: { system: 'Be kind.', user: '{{question}}' },
  dataset: {
    name: 'Support',
    cases: [{ id: 'c1', vars: { question: 'Refund?' }, expected: 'yes' }],
  },
  models: [{ providerConfigId: 'cfg-openai', model: 'gpt-6-luna' }],
  scorers: [
    { id: 's1', kind: 'exact-match' as const, expectedFrom: 'expected' as const },
    {
      id: 's2',
      kind: 'judge' as const,
      judgeModel: { providerConfigId: 'cfg-claude', model: 'claude-sonnet-5-5' },
      passThreshold: 0.7,
      rubric: 'Helpful',
    },
  ],
  concurrency: 4,
  passThreshold: 0.8,
  providers: {
    'cfg-openai': { provider: 'openai' as const, label: 'OpenAI' },
    'cfg-claude': { provider: 'anthropic' as const, label: 'Claude' },
    'cfg-unused': { provider: 'gemini' as const },
  },
};

describe('eval file export (#1045)', () => {
  it('exports referenced endpoints with env credential names and no secrets', () => {
    const file = buildEvalFile(source);
    expect(file.endpoints).toEqual({
      'cfg-openai': { provider: 'openai', label: 'OpenAI', credentialEnv: 'OPENAI_API_KEY' },
      'cfg-claude': { provider: 'anthropic', label: 'Claude', credentialEnv: 'ANTHROPIC_API_KEY' },
    });
    expect(file.passThreshold).toBe(0.8);
    expect(EvalFileSchema.parse(JSON.parse(JSON.stringify(file)))).toEqual(file);
  });

  it('rejects a model or judge naming an unknown endpoint', () => {
    const file = buildEvalFile(source);
    const broken = { ...file, models: [{ providerConfigId: 'missing', model: 'x' }] };
    expect(EvalFileSchema.safeParse(broken).success).toBe(false);
  });

  it('rejects malformed scorers instead of silently stripping them', () => {
    const file = buildEvalFile(source);
    const broken = { ...file, scorers: [{ id: 'x', kind: 'regex' }] };
    expect(EvalFileSchema.safeParse(broken).success).toBe(false);
  });

  it('defaults the pass threshold to 100%', () => {
    const { passThreshold: _drop, ...rest } = buildEvalFile(source);
    expect(EvalFileSchema.parse(rest).passThreshold).toBe(1);
  });
});
