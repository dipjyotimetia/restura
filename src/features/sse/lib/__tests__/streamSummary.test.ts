import { describe, expect, it } from 'vitest';
import {
  appendSseEventToSummary,
  createSseStreamSummary,
  getSseSummaryView,
  rebuildSseStreamSummary,
} from '../streamSummary';

const event = (eventName: string, data: string, timestamp = 100) => ({
  kind: 'event' as const,
  id: `${eventName}-${timestamp}`,
  event: eventName,
  data,
  timestamp,
});

describe('SSE stream summaries', () => {
  it('updates display metrics incrementally as events arrive', () => {
    let summary = createSseStreamSummary();

    summary = appendSseEventToSummary(summary, {
      kind: 'event',
      id: 'first',
      event: 'token',
      data: 'hello ',
      timestamp: 100,
    });
    summary = appendSseEventToSummary(summary, {
      kind: 'event',
      id: 'second',
      event: 'message',
      data: JSON.stringify({ delta: 'world', phase: 'generate' }),
      timestamp: 160,
    });
    summary = appendSseEventToSummary(summary, {
      kind: 'event',
      id: 'third',
      event: 'progress',
      data: '50',
      timestamp: 220,
    });
    summary = appendSseEventToSummary(summary, {
      kind: 'event',
      id: 'fourth',
      event: 'done',
      data: '',
      timestamp: 280,
    });

    expect(getSseSummaryView(summary)).toEqual({
      eventCount: 4,
      bytes: 'hello '.length + JSON.stringify({ delta: 'world', phase: 'generate' }).length + 2,
      tokenCount: 2,
      avgGapMs: 60,
      assembledText: 'hello world',
      progress: 1,
      phases: [{ id: 'generate', label: 'generate', state: 'done' }],
      eventNames: ['done', 'message', 'progress', 'token'],
    });
  });

  it('summarizes JSON message alternatives, phases, and duplicate event names', () => {
    let summary = createSseStreamSummary();
    summary = appendSseEventToSummary(summary, event('message', JSON.stringify({ text: 'first' })));
    summary = appendSseEventToSummary(
      summary,
      event('message', JSON.stringify({ token: ' second', phase: 'plan' }), 200)
    );
    summary = appendSseEventToSummary(
      summary,
      event('message', JSON.stringify({ delta: ' third', phase: 'execute' }), 300)
    );
    summary = appendSseEventToSummary(
      summary,
      event('message', JSON.stringify({ phase: 'execute' }), 400)
    );

    expect(summary).toMatchObject({
      assembledText: 'first second third',
      tokenCount: 2,
      eventNames: ['message'],
      phaseOrder: ['plan', 'execute'],
      phaseStates: { plan: 'done', execute: 'active' },
    });
  });

  it('keeps unsupported and malformed message payloads in metrics without assembling text', () => {
    const empty = appendSseEventToSummary(
      createSseStreamSummary(),
      event('message', JSON.stringify({ ignored: true }))
    );
    const malformed = appendSseEventToSummary(empty, event('message', 'not json', 200));

    expect(malformed).toMatchObject({ eventCount: 2, tokenCount: 0, assembledText: '' });

    const unknown = appendSseEventToSummary(malformed, event('heartbeat', 'alive', 300));
    expect(unknown).toMatchObject({ eventCount: 3, assembledText: '' });
  });

  it('accepts numeric and object progress payloads while ignoring invalid progress', () => {
    let summary = createSseStreamSummary();
    summary = appendSseEventToSummary(summary, event('progress', '0.5'));
    expect(summary.progress).toBe(0.5);

    summary = appendSseEventToSummary(
      summary,
      event('progress', JSON.stringify({ progress: 25 }), 200)
    );
    expect(summary.progress).toBe(0.25);

    summary = appendSseEventToSummary(
      summary,
      event('progress', JSON.stringify({ value: 2 }), 300)
    );
    expect(summary.progress).toBe(0.02);

    summary = appendSseEventToSummary(
      summary,
      event('progress', JSON.stringify({ value: 'nope' }), 400)
    );
    summary = appendSseEventToSummary(summary, event('progress', 'not a number', 500));
    expect(summary.progress).toBe(0.02);

    summary = appendSseEventToSummary(summary, event('progress', '+5', 600));
    expect(summary.progress).toBe(0.05);

    summary = appendSseEventToSummary(summary, event('progress', '.5', 700));
    expect(summary.progress).toBe(0.5);
  });

  it('rebuilds event summaries and exposes empty-state view fallbacks', () => {
    const summary = rebuildSseStreamSummary([
      { kind: 'system', id: 'system', message: 'connected', timestamp: 100 },
      event('token', 'hello', 200),
    ]);
    const view = getSseSummaryView({
      ...createSseStreamSummary(),
      phaseOrder: ['waiting'],
    });

    expect(summary).toMatchObject({ eventCount: 1, assembledText: 'hello' });
    expect(view.avgGapMs).toBeNull();
    expect(view.phases).toEqual([{ id: 'waiting', label: 'waiting', state: 'pending' }]);
  });
});
