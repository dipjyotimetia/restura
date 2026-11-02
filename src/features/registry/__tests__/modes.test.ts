import { describe, expect, it } from 'vitest';
import {
  MODE_DESCRIPTORS,
  MODES_IN_COMMAND_ORDER,
  MODES_IN_MENU_ORDER,
  protocolRunTraits,
} from '../modes';

describe('MODE_DESCRIPTORS', () => {
  it('keeps the new-request menu order', () => {
    expect(MODES_IN_MENU_ORDER).toEqual([
      'http',
      'graphql',
      'grpc',
      'websocket',
      'socketio',
      'sse',
      'mcp',
      'kafka',
      'mqtt',
    ]);
  });

  it('keeps the command-palette order and labels', () => {
    expect(MODES_IN_COMMAND_ORDER.map((m) => MODE_DESCRIPTORS[m].commandLabel)).toEqual([
      'New HTTP request',
      'New gRPC request',
      'New GraphQL request',
      'New WS',
      'New Socket.IO',
      'New SSE stream',
      'New MCP request',
      'New Kafka client',
      'New MQTT client',
    ]);
  });

  it('gates exactly Kafka and MQTT to desktop', () => {
    const desktopOnly = MODES_IN_MENU_ORDER.filter((m) => MODE_DESCRIPTORS[m].desktopOnly);
    expect(desktopOnly).toEqual(['kafka', 'mqtt']);
  });

  it('matches the collection runner membership today', () => {
    expect(MODES_IN_MENU_ORDER.filter((m) => !MODE_DESCRIPTORS[m].runnable)).toEqual([
      'websocket',
      'socketio',
      'sse',
      'kafka',
    ]);
    expect(MODES_IN_MENU_ORDER.filter((m) => MODE_DESCRIPTORS[m].honorsSkipRequest)).toEqual([
      'http',
      'grpc',
      'mcp',
    ]);
  });
});

describe('protocolRunTraits', () => {
  it('reads a known protocol from its descriptor', () => {
    expect(protocolRunTraits('sse').runnable).toBe(false);
    expect(protocolRunTraits('grpc').honorsSkipRequest).toBe(true);
  });

  it('treats an unknown or inherited name as no trait, not an Object member', () => {
    for (const id of ['nope', 'constructor', 'toString']) {
      expect(protocolRunTraits(id)).toEqual({ runnable: true, honorsSkipRequest: false });
    }
  });
});
