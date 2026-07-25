// @vitest-environment node

import type { EventEmitter as EventEmitterType } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENT } from '../../shared/channels';

const { ee } = vi.hoisted(() => {
  const { EventEmitter } = require('node:events');
  return { ee: new EventEmitter() as EventEmitterType };
});

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: vi.fn(),
    on: (channel: string, listener: (...args: unknown[]) => void) => ee.on(channel, listener),
    removeListener: (channel: string, listener: (...args: unknown[]) => void) =>
      ee.removeListener(channel, listener),
  },
}));

import { integrationApi } from '../preload/integration-api';

describe('integrationApi subscriptions', () => {
  beforeEach(() => {
    ee.removeAllListeners();
  });

  it('disposes only the capture listener created by that subscription', () => {
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = integrationApi.capture.onReceived(first);
    const disposeSecond = integrationApi.capture.onReceived(second);

    ee.emit(EVENT.captureReceived, {}, { items: [] });
    disposeFirst();
    ee.emit(EVENT.captureReceived, {}, { items: [{ name: 'kept' }] });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(ee.listenerCount(EVENT.captureReceived)).toBe(1);

    disposeSecond();
    expect(ee.listenerCount(EVENT.captureReceived)).toBe(0);
  });

  it('disposes only the file-change listener created by that subscription', () => {
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = integrationApi.collections.onFileChanged(first);
    const disposeSecond = integrationApi.collections.onFileChanged(second);
    const event = {
      type: 'modified' as const,
      filePath: '/tmp/demo/request.yaml',
      directoryPath: '/tmp/demo',
    };

    ee.emit(EVENT.collectionFileChanged, {}, event);
    disposeFirst();
    ee.emit(EVENT.collectionFileChanged, {}, { ...event, type: 'deleted' });

    expect(first).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledTimes(2);
    expect(ee.listenerCount(EVENT.collectionFileChanged)).toBe(1);

    disposeSecond();
    expect(ee.listenerCount(EVENT.collectionFileChanged)).toBe(0);
  });
});
