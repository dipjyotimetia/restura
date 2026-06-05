// @vitest-environment node
//
// Trust-boundary parity: every streaming connect handler must reject IPC from
// an untrusted (non-file://) frame BEFORE touching the transport. assertTrusted-
// Sender is the first line in each handler; this proves none of them regressed
// it. A compromised/iframe renderer must not be able to open outbound sockets.
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  createElectronMock,
  untrustedEvent,
  getRegisteredHandler,
  silenceLogger,
} from './helpers/electron-mock';

vi.mock('electron', () => createElectronMock());

// Silence the validation/trust error logs (they're asserted via throw, not output).
vi.mock('../../../src/lib/shared/logger', (orig) => silenceLogger(orig));

import { ipcMain } from 'electron';
import { IPC } from '../../shared/channels';

import { registerWebSocketHandlerIPC } from '../websocket-handler';
import { registerSocketIoHandlerIPC } from '../socketio-handler';
import { registerSseHandlerIPC } from '../sse-handler';
import { registerMqttHandlerIPC } from '../mqtt-handler';
import { registerKafkaHandlerIPC } from '../kafka-handler';
import { registerMcpHandlerIPC } from '../mcp-handler';

describe('streaming connect handlers reject untrusted frames', () => {
  beforeEach(() => vi.mocked(ipcMain.handle).mockClear());

  it.each([
    ['ws:connect', registerWebSocketHandlerIPC, IPC.ws.connect],
    ['socketio:connect', registerSocketIoHandlerIPC, IPC.socketio.connect],
    ['sse:connect', registerSseHandlerIPC, IPC.sse.connect],
    ['mqtt:connect', registerMqttHandlerIPC, IPC.mqtt.connect],
    ['kafka:connect', registerKafkaHandlerIPC, IPC.kafka.connect],
    ['mcp:connect', registerMcpHandlerIPC, IPC.mcp.connect],
  ])('%s rejects an untrusted sender frame', async (_name, register, channel) => {
    (register as () => void)();
    const handler = getRegisteredHandler(ipcMain, channel);
    // A well-formed payload — the rejection must come from the trust check,
    // not from input validation.
    const payload = { connectionId: 'c1', url: 'wss://example.com', brokers: ['x:9092'] };
    await expect(handler(untrustedEvent(), payload)).rejects.toThrow(/untrusted frame/i);
  });
});
