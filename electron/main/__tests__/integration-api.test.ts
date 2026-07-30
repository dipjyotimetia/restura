// @vitest-environment node

import type { EventEmitter as EventEmitterType } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENT } from '../../shared/channels';

const { ee, invoke } = vi.hoisted(() => {
  const { EventEmitter } = require('node:events');
  return { ee: new EventEmitter() as EventEmitterType, invoke: vi.fn() };
});

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke,
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

describe('integrationApi Git merge bridge', () => {
  beforeEach(() => invoke.mockReset());

  it('passes typed merge commands as single validated payloads', async () => {
    const resolution = {
      conflictId: 'b'.repeat(64),
      kind: 'choice' as const,
      choice: 'incoming' as const,
    };

    await integrationApi.git.mergeState('/workspace');
    await integrationApi.git.startMerge('/workspace', 'origin/main', 'a'.repeat(40));
    await integrationApi.git.getMergeConflict('/workspace', 'b'.repeat(64));
    await integrationApi.git.resolveMergeConflict('/workspace', resolution);
    await integrationApi.git.abortMerge('/workspace');
    await integrationApi.git.completeMerge('/workspace', 'Merge origin/main');

    expect(invoke.mock.calls).toEqual([
      ['git:merge:state', { directoryPath: '/workspace' }],
      [
        'git:merge:start',
        { directoryPath: '/workspace', sourceRef: 'origin/main', expectedSha: 'a'.repeat(40) },
      ],
      ['git:merge:conflict', { directoryPath: '/workspace', conflictId: 'b'.repeat(64) }],
      ['git:merge:resolve', { directoryPath: '/workspace', resolution }],
      ['git:merge:abort', { directoryPath: '/workspace' }],
      ['git:merge:complete', { directoryPath: '/workspace', message: 'Merge origin/main' }],
    ]);
  });
});
