// @vitest-environment node
//
// Registration-parity for the streaming/protocol handlers: each register fn
// must bind every IPC channel its renderer counterpart invokes, and each
// cleanup fn must run without throwing. Catches a handler dropping a channel,
// a channel-name typo, or a register/cleanup regression — cheaply, without
// driving real transports.
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { createElectronMock } from './helpers/electron-mock';

vi.mock('electron', () => createElectronMock());

import { ipcMain } from 'electron';
import { IPC } from '../../shared/channels';

import { registerHttpHandlerIPC } from '../http-handler';
import { registerWebSocketHandlerIPC, stopWebSocketCleanup } from '../websocket-handler';
import { registerSocketIoHandlerIPC, stopSocketIoCleanup } from '../socketio-handler';
import { registerSseHandlerIPC, stopSseCleanup } from '../sse-handler';
import { registerMqttHandlerIPC, stopMqttCleanup } from '../mqtt-handler';
import { registerKafkaHandlerIPC, stopKafkaCleanup } from '../kafka-handler';
import { registerMcpHandlerIPC, stopMcpCleanup } from '../mcp-handler';
import { registerGrpcReflectionIPC } from '../grpc-reflection-handler';

function registeredChannels(): string[] {
  return vi.mocked(ipcMain.handle).mock.calls.map((c) => c[0] as string);
}

describe('streaming-handler registration parity', () => {
  beforeEach(() => vi.mocked(ipcMain.handle).mockClear());

  it.each([
    ['http', registerHttpHandlerIPC, [IPC.http.request]],
    ['websocket', registerWebSocketHandlerIPC, [IPC.ws.connect, IPC.ws.send, IPC.ws.disconnect]],
    [
      'socketio',
      registerSocketIoHandlerIPC,
      [IPC.socketio.connect, IPC.socketio.emit, IPC.socketio.disconnect],
    ],
    ['sse', registerSseHandlerIPC, [IPC.sse.connect, IPC.sse.disconnect]],
    [
      'mqtt',
      registerMqttHandlerIPC,
      [
        IPC.mqtt.connect,
        IPC.mqtt.publish,
        IPC.mqtt.subscribe,
        IPC.mqtt.unsubscribe,
        IPC.mqtt.disconnect,
      ],
    ],
    [
      'kafka',
      registerKafkaHandlerIPC,
      [
        IPC.kafka.connect,
        IPC.kafka.produce,
        IPC.kafka.subscribe,
        IPC.kafka.unsubscribe,
        IPC.kafka.disconnect,
        IPC.kafka.listTopics,
        IPC.kafka.createTopic,
        IPC.kafka.deleteTopic,
        IPC.kafka.listGroups,
      ],
    ],
    ['mcp', registerMcpHandlerIPC, [IPC.mcp.connect, IPC.mcp.request, IPC.mcp.disconnect]],
    ['grpc-reflection', registerGrpcReflectionIPC, [IPC.grpc.reflect]],
  ])('%s registers all its channels', (_name, register, expected) => {
    (register as () => void)();
    const channels = registeredChannels();
    for (const ch of expected) {
      expect(channels).toContain(ch);
    }
  });

  it('cleanup functions run without throwing', async () => {
    expect(() => stopWebSocketCleanup()).not.toThrow();
    expect(() => stopSocketIoCleanup()).not.toThrow();
    expect(() => stopSseCleanup()).not.toThrow();
    expect(() => stopMcpCleanup()).not.toThrow();
    await expect(stopMqttCleanup()).resolves.not.toThrow();
    await expect(stopKafkaCleanup()).resolves.not.toThrow();
  });
});
