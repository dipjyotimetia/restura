import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSocketIOStore } from '@/features/socketio/store/useSocketIOStore';
import type { StreamingVariableScope } from '@/lib/shared/streaming/messageVariables';
import { emitWithVariables, parseEmitArgs } from '../emitWithVariables';
import { socketioManager } from '../socketioManager';

const scope: StreamingVariableScope = {
  values: { room: 'lobby', token: 'sekrit', n: '7', evt: 'join' },
  secretNames: new Set(['token']),
  handleNames: new Set(),
};

describe('parseEmitArgs', () => {
  it('handles empty, arrays, scalars and invalid JSON', () => {
    expect(parseEmitArgs('  ')).toEqual({ ok: true, args: [] });
    expect(parseEmitArgs('[1,"a"]')).toEqual({ ok: true, args: [1, 'a'] });
    expect(parseEmitArgs('"hi"')).toEqual({ ok: true, args: ['hi'] });
    expect(parseEmitArgs('{oops').ok).toBe(false);
  });
});

describe('emitWithVariables', () => {
  let id: string;
  let emit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    id = useSocketIOStore.getState().createConnection();
    emit = vi.spyOn(socketioManager, 'emit').mockImplementation(() => {});
  });

  afterEach(() => {
    useSocketIOStore.getState().removeConnection(id);
    vi.restoreAllMocks();
  });

  const events = () => useSocketIOStore.getState().connections[id]?.events ?? [];

  it('resolves the event name and args before parsing', () => {
    expect(
      emitWithVariables(
        id,
        { eventName: '{{evt}}', args: '[{"room":"{{room}}"},{{n}}]', ack: true },
        scope
      )
    ).toEqual({ ok: true });
    expect(emit).toHaveBeenCalledWith(id, 'join', [{ room: 'lobby' }, 7], true, undefined);
  });

  it('defaults a blank event name to "message"', () => {
    emitWithVariables(id, { eventName: ' ', args: '', ack: false }, scope);
    expect(emit).toHaveBeenCalledWith(id, 'message', [], false, undefined);
  });

  it('returns parse errors without emitting', () => {
    const out = emitWithVariables(id, { eventName: 'x', args: '{bad', ack: false }, scope);
    expect(out.ok).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it('warns once about unresolved variables across name and args', () => {
    emitWithVariables(
      id,
      { eventName: '{{who}}', args: '["{{who}}","{{what}}"]', ack: false },
      scope
    );
    expect(events().map((e) => e.args[0])).toEqual([
      'Unresolved variables sent literally: {{who}}, {{what}}',
    ]);
  });

  it('masks secrets in the logged copy', () => {
    emitWithVariables(id, { eventName: 'auth', args: '{"t":"{{token}}"}', ack: false }, scope);
    expect(emit).toHaveBeenCalledWith(id, 'auth', [{ t: 'sekrit' }], false, {
      eventName: 'auth',
      args: [{ t: '••••••' }],
    });
  });

  it('never echoes a secret in the JSON parse error', () => {
    const out = emitWithVariables(
      id,
      { eventName: 'x', args: '{"t": {{token}} }', ack: false },
      scope
    );
    expect(out.ok).toBe(false);
    expect(out.ok ? '' : out.error).not.toContain('sekrit');
    expect(emit).not.toHaveBeenCalled();
  });

  it('uses a generic error when only the resolved secret breaks the JSON', () => {
    const quoty: StreamingVariableScope = {
      ...scope,
      values: { token: 'a"b' },
      secretNames: new Set(['token']),
    };
    const out = emitWithVariables(id, { eventName: 'x', args: '["{{token}}"]', ack: false }, quoty);
    expect(out).toEqual({ ok: false, error: 'Invalid JSON' });
  });

  it('hides args entirely when the masked copy is not valid JSON', () => {
    const numeric: StreamingVariableScope = {
      ...scope,
      values: { pin: '1234' },
      secretNames: new Set(['pin']),
    };
    emitWithVariables(id, { eventName: 'pin', args: '[{{pin}}]', ack: false }, numeric);
    expect(emit).toHaveBeenCalledWith(id, 'pin', [1234], false, {
      eventName: 'pin',
      args: ['[args hidden: contains secret values]'],
    });
  });
});

describe('socketioManager.emit display override', () => {
  it('logs the display copy while emitting the wire args', () => {
    const id = useSocketIOStore.getState().createConnection();
    const socketEmit = vi.fn();
    const sockets = (socketioManager as unknown as { browserSockets: Map<string, unknown> })
      .browserSockets;
    sockets.set(id, { connected: true, emit: socketEmit });
    try {
      socketioManager.emit(id, 'auth', ['sekrit'], false, { eventName: 'auth', args: ['••••••'] });
      expect(socketEmit).toHaveBeenCalledWith('auth', 'sekrit');
      const sent = useSocketIOStore.getState().connections[id]?.events.at(-1);
      expect(sent?.args).toEqual(['••••••']);
    } finally {
      sockets.delete(id);
      useSocketIOStore.getState().removeConnection(id);
    }
  });
});
