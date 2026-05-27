import { getElectronAPI } from '@/lib/shared/platform';
import type { ChatStreamEvent } from '@shared/protocol/ai/types';

/**
 * Bridges IPC chunk events to an AsyncIterable. Unsubscribes on completion
 * (the `end` event), on early `return()`, and on the non-Electron path.
 *
 * Callers MUST invoke this BEFORE electronAPI.ai.chat() — subscription happens
 * synchronously here, and the main process starts emitting before ai.chat()
 * resolves, so subscribing afterwards would drop the earliest events (and the
 * terminating `end`, hanging the iterator). In a non-Electron build it yields a
 * single guard error followed by done.
 */
export function consumeStream(streamId: string): AsyncIterable<ChatStreamEvent> {
  const ai = getElectronAPI()?.ai;
  if (!ai) {
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'error', code: 'guard', message: 'AI not available (non-Electron build).' };
        yield { type: 'done' };
      },
    };
  }

  const queue: ChatStreamEvent[] = [];
  let resolveNext: ((ev: IteratorResult<ChatStreamEvent>) => void) | null = null;
  let finished = false;

  const offChunk = ai.onChunk(streamId, (ev) => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: ev, done: false });
    } else {
      queue.push(ev);
    }
  });

  const offEnd = ai.onEnd(streamId, () => {
    finished = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: undefined as unknown as ChatStreamEvent, done: true });
    }
    offChunk();
    offEnd();
  });

  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<ChatStreamEvent>> {
          const head = queue.shift();
          if (head !== undefined) {
            return Promise.resolve({ value: head, done: false });
          }
          if (finished) {
            return Promise.resolve({ value: undefined as unknown as ChatStreamEvent, done: true });
          }
          return new Promise((res) => {
            resolveNext = res;
          });
        },
        return(): Promise<IteratorResult<ChatStreamEvent>> {
          offChunk();
          offEnd();
          return Promise.resolve({ value: undefined as unknown as ChatStreamEvent, done: true });
        },
      };
    },
  };
}
