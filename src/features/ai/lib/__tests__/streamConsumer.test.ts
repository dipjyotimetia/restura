import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/shared/platform', () => ({ getElectronAPI: vi.fn() }));

import type { ChatStreamEvent } from '@shared/protocol/ai/types';
import { consumeStream } from '@/features/ai/lib/streamConsumer';
import { getElectronAPI } from '@/lib/shared/platform';

type ChunkCb = (ev: ChatStreamEvent) => void;
type EndCb = (p: { reason: 'done' | 'cancelled' | 'error' }) => void;

let chunkCb: ChunkCb | null;
let endCb: EndCb | null;
const offChunk = vi.fn();
const offEnd = vi.fn();

function installFakeAi(): void {
  chunkCb = null;
  endCb = null;
  offChunk.mockClear();
  offEnd.mockClear();
  const ai = {
    chat: vi.fn(),
    cancel: vi.fn(),
    onChunk: (_id: string, cb: ChunkCb) => {
      chunkCb = cb;
      return offChunk;
    },
    onEnd: (_id: string, cb: EndCb) => {
      endCb = cb;
      return offEnd;
    },
  };
  vi.mocked(getElectronAPI).mockReturnValue({ ai } as never);
}

describe('consumeStream', () => {
  beforeEach(() => {
    vi.mocked(getElectronAPI).mockReset();
  });

  it('drains chunks queued before consumption, then ends', async () => {
    installFakeAi();
    const iterator = consumeStream('s1')[Symbol.asyncIterator]();

    chunkCb!({ type: 'delta', text: 'a' });
    chunkCb!({ type: 'delta', text: 'b' });
    endCb!({ reason: 'done' });

    const r1 = await iterator.next();
    const r2 = await iterator.next();
    const r3 = await iterator.next();

    expect(r1).toEqual({ value: { type: 'delta', text: 'a' }, done: false });
    expect(r2).toEqual({ value: { type: 'delta', text: 'b' }, done: false });
    expect(r3.done).toBe(true);
    expect(offChunk).toHaveBeenCalled();
    expect(offEnd).toHaveBeenCalled();
  });

  it('resolves a pending next() when a chunk arrives later', async () => {
    installFakeAi();
    const iterator = consumeStream('s2')[Symbol.asyncIterator]();

    const pending = iterator.next(); // no queued items, not finished → pending
    chunkCb!({ type: 'delta', text: 'x' });

    const r = await pending;
    expect(r).toEqual({ value: { type: 'delta', text: 'x' }, done: false });
  });

  it('yields a guard error then done in a non-Electron build', async () => {
    vi.mocked(getElectronAPI).mockReturnValue(null);
    const events: ChatStreamEvent[] = [];
    for await (const ev of consumeStream('s3')) events.push(ev);
    expect(events[0]).toMatchObject({ type: 'error', code: 'guard' });
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('unsubscribes when the consumer breaks early (return)', async () => {
    installFakeAi();
    const iterator = consumeStream('s4')[Symbol.asyncIterator]();
    const r = await iterator.return!();
    expect(r.done).toBe(true);
    expect(offChunk).toHaveBeenCalled();
    expect(offEnd).toHaveBeenCalled();
  });
});
