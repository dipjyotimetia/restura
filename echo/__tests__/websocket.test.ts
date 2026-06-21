// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { websocketEcho } from '../handlers/websocket';

// Minimal WSContext mock
function makeWsMock() {
  const sent: unknown[] = [];
  return {
    ws: {
      send: (data: unknown) => {
        sent.push(data);
      },
      close: () => {},
      readyState: 1,
      url: null,
      protocol: null,
      raw: undefined,
    },
    sent,
  };
}

function makeTextEvent(data: string): MessageEvent {
  return { data } as unknown as MessageEvent;
}

function makeArrayBufferEvent(data: ArrayBuffer): MessageEvent {
  return { data } as unknown as MessageEvent;
}

describe('websocketEcho', () => {
  it('echoes text messages as JSON', () => {
    const { ws, sent } = makeWsMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(maintainability): narrow this test fixture cast (Hono Context)
    const handler = websocketEcho({} as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(maintainability): narrow this test fixture cast (WSContext)
    handler.onMessage!(makeTextEvent('hello world'), ws as any);
    expect(sent).toHaveLength(1);
    const reply = JSON.parse(sent[0] as string);
    expect(reply.echo).toBe(true);
    expect(reply.received).toBe('hello world');
    expect(reply.timestamp).toBeDefined();
    expect(reply.size).toBe(11); // 'hello world' is 11 bytes
    expect(reply.parsed).toBeUndefined();
  });

  it('includes parsed field when text is valid JSON', () => {
    const { ws, sent } = makeWsMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(maintainability): narrow this test fixture cast (Hono Context)
    const handler = websocketEcho({} as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(maintainability): narrow this test fixture cast (WSContext)
    handler.onMessage!(makeTextEvent('{"key":"value"}'), ws as any);
    const reply = JSON.parse(sent[0] as string);
    expect(reply.parsed).toEqual({ key: 'value' });
  });

  it('echoes ArrayBuffer unchanged', () => {
    const { ws, sent } = makeWsMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(maintainability): narrow this test fixture cast (Hono Context)
    const handler = websocketEcho({} as any);
    const buf = new ArrayBuffer(4);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(maintainability): narrow this test fixture cast (WSContext)
    handler.onMessage!(makeArrayBufferEvent(buf), ws as any);
    expect(sent[0]).toBe(buf);
  });
});
