// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import {
  ConsumerFlowControl,
  EMIT_QUEUE_HIGH_WATER,
  EMIT_QUEUE_LOW_WATER,
} from '../handlers/kafka/consumer-flow';

function fakeStream() {
  return { pause: vi.fn(), resume: vi.fn() };
}

function queue(flow: ConsumerFlowControl, n: number): void {
  for (let i = 0; i < n; i += 1) flow.emitQueued();
}

function settle(flow: ConsumerFlowControl, n: number): void {
  for (let i = 0; i < n; i += 1) flow.emitSettled();
}

describe('ConsumerFlowControl — backpressure', () => {
  it('defaults to a 500 high-water mark released at 250', () => {
    expect(EMIT_QUEUE_HIGH_WATER).toBe(500);
    expect(EMIT_QUEUE_LOW_WATER).toBe(250);
  });

  it('pauses once the emit queue exceeds the bound and resumes after draining to half', () => {
    const stream = fakeStream();
    const flow = new ConsumerFlowControl();
    flow.attach(stream);
    stream.resume.mockClear();

    queue(flow, EMIT_QUEUE_HIGH_WATER);
    expect(stream.pause).not.toHaveBeenCalled();
    flow.emitQueued();
    expect(stream.pause).toHaveBeenCalledTimes(1);
    expect(flow.backpressurePaused).toBe(true);

    // Further queueing while paused does not re-pause.
    queue(flow, 10);
    expect(stream.pause).toHaveBeenCalledTimes(1);

    settle(flow, EMIT_QUEUE_HIGH_WATER + 11 - EMIT_QUEUE_LOW_WATER - 1);
    expect(stream.resume).not.toHaveBeenCalled();
    flow.emitSettled();
    expect(flow.pendingEmits).toBe(EMIT_QUEUE_LOW_WATER);
    expect(stream.resume).toHaveBeenCalledTimes(1);
    expect(flow.backpressurePaused).toBe(false);
    expect(flow.streamPaused).toBe(false);
  });

  it('never lets the pending count go negative', () => {
    const flow = new ConsumerFlowControl(2, 1);
    flow.emitSettled();
    expect(flow.pendingEmits).toBe(0);
  });

  it('a backpressure drain does not resume a user-paused stream', () => {
    const stream = fakeStream();
    const flow = new ConsumerFlowControl(4, 2);
    flow.attach(stream);
    stream.resume.mockClear();

    queue(flow, 5); // backpressure → pause
    expect(stream.pause).toHaveBeenCalledTimes(1);
    flow.setUserPaused(true); // already paused → no extra native call
    expect(stream.pause).toHaveBeenCalledTimes(1);

    settle(flow, 5); // backpressure released, but the user reason remains
    expect(flow.backpressurePaused).toBe(false);
    expect(stream.resume).not.toHaveBeenCalled();
    expect(flow.streamPaused).toBe(true);

    flow.setUserPaused(false);
    expect(stream.resume).toHaveBeenCalledTimes(1);
  });

  it('a user resume does not defeat active backpressure', () => {
    const stream = fakeStream();
    const flow = new ConsumerFlowControl(4, 2);
    flow.attach(stream);
    stream.resume.mockClear();

    flow.setUserPaused(true);
    expect(stream.pause).toHaveBeenCalledTimes(1);
    queue(flow, 5);
    flow.setUserPaused(false);
    expect(stream.resume).not.toHaveBeenCalled();
    expect(flow.streamPaused).toBe(true);

    settle(flow, 3);
    expect(stream.resume).toHaveBeenCalledTimes(1);
  });

  it('applies accumulated pause reasons to a newly attached stream', () => {
    const first = fakeStream();
    const flow = new ConsumerFlowControl();
    flow.attach(first);
    flow.detach();
    flow.setUserPaused(true);
    expect(first.pause).not.toHaveBeenCalled();

    const second = fakeStream();
    flow.attach(second);
    expect(second.pause).toHaveBeenCalledTimes(1);
    expect(second.resume).not.toHaveBeenCalled();

    const third = fakeStream();
    flow.setUserPaused(false);
    flow.attach(third);
    expect(third.resume).toHaveBeenCalledTimes(1);
  });
});
