// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AiChatMessageSchema } from '../ipc/validators/ai';

describe('AiChatMessageSchema', () => {
  it('keeps a Gemini thoughtSignature on a replayed tool call across the IPC hop', () => {
    const parsed = AiChatMessageSchema.parse({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'lookup', input: '{}', thoughtSignature: 'sig-abc' }],
    });
    expect(parsed.toolCalls?.[0]?.thoughtSignature).toBe('sig-abc');
  });
});
