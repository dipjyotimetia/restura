import { describe, it, expect } from 'vitest';
import { buildMessages, SYSTEM_EXPLAIN_PROMPT } from '@/features/ai/lib/promptBuilder';
import type { RawSnapshot } from '@/features/ai/lib/contextSnapshot';

const snapshot: RawSnapshot = {
  contextRef: { kind: 'response', tabId: 't1', capturedAt: 0 },
  request: { method: 'GET', url: 'https://api/users', headers: { Authorization: 'Bearer sk-x' }, body: '' },
  response: { status: 401, headers: { 'WWW-Authenticate': 'Bearer' }, body: '{"error":"unauth"}' },
  environment: { baseUrl: 'https://api', token: 'sk-secret' },
};

describe('buildMessages', () => {
  it('puts SYSTEM_EXPLAIN_PROMPT first', () => {
    const msgs = buildMessages({ snapshot, priorTurns: [], userText: 'why', rawMode: false });
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[0]?.content).toBe(SYSTEM_EXPLAIN_PROMPT);
  });

  it('appends prior turns in order between system and user', () => {
    const msgs = buildMessages({
      snapshot,
      priorTurns: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }],
      userText: 'q2',
      rawMode: false,
    });
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(msgs.at(-1)?.content).toContain('q2');
  });

  it('redacts Authorization and JWT-like tokens in default mode', () => {
    const msgs = buildMessages({ snapshot, priorTurns: [], userText: 'why', rawMode: false });
    const last = msgs.at(-1)!.content;
    expect(last).not.toContain('Bearer sk-x');
    expect(last).toContain('[REDACTED]');
  });

  it('redacts env values but exposes names', () => {
    const msgs = buildMessages({ snapshot, priorTurns: [], userText: 'why', rawMode: false });
    const last = msgs.at(-1)!.content;
    expect(last).toContain('baseUrl');
    expect(last).toContain('token');
    expect(last).not.toContain('sk-secret');
    expect(last).not.toContain('https://api');
  });

  it('passes secrets through in raw mode', () => {
    const msgs = buildMessages({ snapshot, priorTurns: [], userText: 'why', rawMode: true });
    expect(msgs.at(-1)!.content).toContain('Bearer sk-x');
  });
});
