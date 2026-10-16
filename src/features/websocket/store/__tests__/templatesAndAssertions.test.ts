import { beforeEach, describe, expect, it } from 'vitest';
import { useWebSocketStore } from '../useWebSocketStore';

const store = () => useWebSocketStore.getState();

describe('useWebSocketStore templates + frame assertions', () => {
  let id: string;

  beforeEach(() => {
    for (const cid of Object.keys(store().connections)) store().removeConnection(cid);
    id = store().createConnection();
  });

  it('starts with no templates and stores them unresolved', () => {
    expect(store().connections[id]?.templates).toEqual([]);
    const templates = [
      { id: 't1', name: 'Login', body: '{"t":"{{token}}"}', format: 'json' as const },
    ];
    store().setTemplates(id, templates);
    expect(store().connections[id]?.templates).toEqual(templates);
  });

  it('sets the frame assertion config', () => {
    store().setFrameAssertion(id, { enabled: true, script: 'pm.test("x", () => {})' });
    expect(store().connections[id]?.frameAssertion).toEqual({
      enabled: true,
      script: 'pm.test("x", () => {})',
    });
  });

  it('attaches an assertion result to one message', () => {
    store().addMessage(id, 'received', 'a');
    store().addMessage(id, 'received', 'b');
    const second = store().connections[id]?.messages[1];
    const result = {
      status: 'passed' as const,
      tests: [{ name: 'ok', passed: true }],
      errors: [],
    };
    store().setMessageAssertion(id, second?.id ?? '', result);
    const messages = store().connections[id]?.messages ?? [];
    expect(messages[0]?.assertion).toBeUndefined();
    expect(messages[1]?.assertion).toEqual(result);
  });

  it('ignores unknown connections and messages', () => {
    const before = store().connections;
    store().setTemplates('nope', []);
    store().setFrameAssertion('nope', { enabled: true, script: '' });
    store().setMessageAssertion('nope', 'm', { status: 'error', tests: [], errors: [] });
    store().setMessageAssertion(id, 'missing', { status: 'error', tests: [], errors: [] });
    expect(store().connections).toBe(before);
  });

  it('persists templates and the assertion config but not results', () => {
    store().setTemplates(id, [{ id: 't', name: 'n', body: 'b', format: 'text' }]);
    store().setFrameAssertion(id, { enabled: true, script: 's' });
    store().addMessage(id, 'received', 'x');
    const partialize = useWebSocketStore.persist.getOptions().partialize;
    const persisted = partialize?.(store()) as unknown as {
      connections: Record<
        string,
        { templates: unknown[]; frameAssertion: unknown; messages: unknown[] }
      >;
    };
    expect(persisted.connections[id]?.templates).toHaveLength(1);
    expect(persisted.connections[id]?.frameAssertion).toEqual({ enabled: true, script: 's' });
    expect(persisted.connections[id]?.messages).toEqual([]);
  });
});
