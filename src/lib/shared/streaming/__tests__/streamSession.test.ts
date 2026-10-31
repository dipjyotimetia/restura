import { describe, expect, it } from 'vitest';
import { createStreamSequence, openStreamSession } from '../streamSession';
import { createInMemoryStreamAdapter } from './inMemoryStreamAdapter';

type Kind = 'open' | 'event' | 'error' | 'close';

const noop = () => undefined;

describe('openStreamSession', () => {
  it('registers listeners in declaration order and only connects on request', () => {
    const { adapter, calls } = createInMemoryStreamAdapter<Kind>();
    openStreamSession(adapter, {
      listeners: { open: noop, event: noop, error: noop, close: noop },
    });
    expect(calls).toEqual(['listen:open', 'listen:event', 'listen:error', 'listen:close']);
  });

  it('delivers adapter events to the matching listener', async () => {
    const { adapter, emit } = createInMemoryStreamAdapter<Kind>();
    const seen: unknown[] = [];
    const session = openStreamSession(adapter, {
      listeners: { event: (p) => seen.push(p) },
    });
    await session.connect();
    emit('event', 'a');
    emit('open', 'ignored');
    expect(seen).toEqual(['a']);
  });

  it('dispose removes listeners once and leaves the connection alone', () => {
    const { adapter, calls, hasListeners } = createInMemoryStreamAdapter<Kind>();
    const session = openStreamSession(adapter, { listeners: { event: noop } });
    session.dispose();
    session.dispose();
    expect(hasListeners()).toBe(false);
    expect(calls.filter((c) => c === 'removeListeners')).toHaveLength(1);
    expect(calls).not.toContain('disconnect');
  });

  it('disconnect reaches the adapter at most once and swallows a rejection', async () => {
    const { adapter, calls } = createInMemoryStreamAdapter<Kind>();
    const session = openStreamSession(
      {
        ...adapter,
        disconnect: () => {
          calls.push('disconnect');
          return Promise.reject(new Error('x'));
        },
      },
      { listeners: {} }
    );
    session.disconnect();
    session.disconnect();
    await Promise.resolve();
    expect(calls.filter((c) => c === 'disconnect')).toHaveLength(1);
  });

  it('close disconnects, then removes listeners', () => {
    const { adapter, calls } = createInMemoryStreamAdapter<Kind>();
    const session = openStreamSession(adapter, { listeners: { event: noop } });
    session.close();
    expect(calls).toEqual(['listen:event', 'disconnect', 'removeListeners']);
  });

  describe('abort', () => {
    it('before open: listeners attach, disconnect is sent, and connect never reaches the adapter', async () => {
      const controller = new AbortController();
      controller.abort();
      const { adapter, calls } = createInMemoryStreamAdapter<Kind>();
      const aborted: string[] = [];
      const session = openStreamSession(adapter, {
        listeners: { event: noop },
        signal: controller.signal,
        onAbort: () => aborted.push('onAbort'),
      });

      await expect(session.connect()).rejects.toMatchObject({ name: 'AbortError' });
      expect(calls).toEqual(['listen:event', 'disconnect']);
      expect(aborted).toEqual(['onAbort']);
    });

    it('while open: fires onAbort and disconnects once', async () => {
      const controller = new AbortController();
      const { adapter, calls } = createInMemoryStreamAdapter<Kind>();
      const aborted: string[] = [];
      const session = openStreamSession(adapter, {
        listeners: {},
        signal: controller.signal,
        onAbort: () => aborted.push('onAbort'),
      });
      await session.connect();
      controller.abort();
      session.disconnect();
      expect(aborted).toEqual(['onAbort']);
      expect(calls.filter((c) => c === 'disconnect')).toHaveLength(1);
    });

    it('after dispose: the signal no longer reaches the session', () => {
      const controller = new AbortController();
      const { adapter, calls } = createInMemoryStreamAdapter<Kind>();
      const session = openStreamSession(adapter, { listeners: {}, signal: controller.signal });
      session.dispose();
      controller.abort();
      expect(calls).not.toContain('disconnect');
    });
  });

  it('surfaces a connect result and rejection unchanged', async () => {
    const failing = createInMemoryStreamAdapter<Kind>(async () => ({
      success: false,
      error: 'blocked',
    }));
    await expect(openStreamSession(failing.adapter, { listeners: {} }).connect()).resolves.toEqual({
      success: false,
      error: 'blocked',
    });
    const rejecting = createInMemoryStreamAdapter<Kind>(() =>
      Promise.reject(new Error('ipc down'))
    );
    await expect(openStreamSession(rejecting.adapter, { listeners: {} }).connect()).rejects.toThrow(
      'ipc down'
    );
  });
});

describe('createStreamSequence', () => {
  it('yields queued items in order, then finishes on end', async () => {
    const seq = createStreamSequence<number>();
    seq.push(1);
    seq.push(2);
    seq.end();
    const out: number[] = [];
    for await (const n of seq.iterate()) out.push(n);
    expect(out).toEqual([1, 2]);
  });

  it('wakes a waiting consumer when an item arrives', async () => {
    const seq = createStreamSequence<string>();
    const it = seq.iterate();
    const next = it.next();
    seq.push('late');
    await expect(next).resolves.toEqual({ done: false, value: 'late' });
  });

  it('wakes a waiting consumer on end', async () => {
    const seq = createStreamSequence<string>();
    const it = seq.iterate();
    const next = it.next();
    seq.end();
    await expect(next).resolves.toEqual({ done: true, value: undefined });
  });

  it('drains queued items before throwing the recorded failure', async () => {
    const seq = createStreamSequence<number>();
    const it = seq.iterate();
    seq.push(1);
    seq.fail(new Error('boom'));
    seq.end();
    await expect(it.next()).resolves.toEqual({ done: false, value: 1 });
    await expect(it.next()).rejects.toThrow('boom');
  });

  it('a failure only surfaces once the sequence has ended, and the latest one wins', async () => {
    const seq = createStreamSequence<number>();
    const it = seq.iterate();
    seq.fail(new Error('first'));
    seq.push(1);
    await expect(it.next()).resolves.toEqual({ done: false, value: 1 });
    seq.push(2);
    seq.end();
    await expect(it.next()).resolves.toEqual({ done: false, value: 2 });
    // Recorded after end, before the consumer reached the end of the queue.
    seq.fail(new Error('second'));
    await expect(it.next()).rejects.toThrow('second');
  });

  it('runs onFinish on completion, on failure, and when the consumer breaks out', async () => {
    const finished: string[] = [];

    const completed = createStreamSequence<number>();
    completed.end();
    for await (const _ of completed.iterate(() => void finished.push('completed'))) {
      // nothing queued
    }

    const failed = createStreamSequence<number>();
    failed.fail(new Error('x'));
    failed.end();
    await failed
      .iterate(() => void finished.push('failed'))
      .next()
      .catch(noop);

    const broken = createStreamSequence<number>();
    broken.push(1);
    for await (const _ of broken.iterate(() => void finished.push('broken'))) break;

    expect(finished).toEqual(['completed', 'failed', 'broken']);
  });

  it('reports whether it has ended, and end is idempotent', () => {
    const seq = createStreamSequence<number>();
    expect(seq.ended).toBe(false);
    seq.end();
    seq.end();
    expect(seq.ended).toBe(true);
  });
});
