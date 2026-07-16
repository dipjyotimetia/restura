import { describe, expect, it } from 'vitest';
import {
  appendSseEventToSummary,
  createSseStreamSummary,
  getSseSummaryView,
} from '../streamSummary';

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
});
