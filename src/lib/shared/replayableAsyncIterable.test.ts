import { describe, expect, it } from 'vitest';
import { replayableAsyncIterable } from './replayableAsyncIterable';

async function* source<T>(items: T[], fail?: Error): AsyncGenerator<T> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
  if (fail) throw fail;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('replayableAsyncIterable', () => {
  it('gives every consumer the whole stream, including late ones', async () => {
    const stream = replayableAsyncIterable(source([1, 2, 3]));
    const [a, b] = await Promise.all([collect(stream), collect(stream)]);
    expect(a).toEqual([1, 2, 3]);
    expect(b).toEqual([1, 2, 3]);
    expect(await collect(stream)).toEqual([1, 2, 3]);
  });

  it("one consumer's break does not end the stream for another", async () => {
    const stream = replayableAsyncIterable(source(['a', 'b', 'c']));
    for await (const item of stream) {
      if (item === 'a') break;
    }
    expect(await collect(stream)).toEqual(['a', 'b', 'c']);
  });

  it('rethrows a source failure to every consumer after the items it produced', async () => {
    const stream = replayableAsyncIterable(source([1], new Error('boom')));
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const item of stream) seen.push(item);
      })()
    ).rejects.toThrow('boom');
    expect(seen).toEqual([1]);
    await expect(collect(stream)).rejects.toThrow('boom');
  });

  it('bounds the replay buffer but keeps the terminal item', async () => {
    const stream = replayableAsyncIterable(source([1, 2, 3, 4, 'end' as const]), {
      maxRetained: 2,
      isTerminal: (item) => item === 'end',
    });
    await collect(stream);
    expect(await collect(stream)).toEqual([4, 'end']);
  });
});
