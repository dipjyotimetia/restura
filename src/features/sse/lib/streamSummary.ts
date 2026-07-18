import type { SseLogEntry } from '@/features/sse/store/useSseStore';

type SsePhaseState = 'pending' | 'active' | 'done';

export interface SseStreamSummary {
  eventCount: number;
  bytes: number;
  tokenCount: number;
  gapCount: number;
  gapTotalMs: number;
  lastEventTimestamp: number | null;
  assembledText: string;
  progress: number | null;
  phaseOrder: string[];
  phaseStates: Record<string, SsePhaseState>;
  eventNames: string[];
}

export interface SseSummaryView {
  eventCount: number;
  bytes: number;
  tokenCount: number;
  avgGapMs: number | null;
  assembledText: string;
  progress: number | null;
  phases: Array<{ id: string; label: string; state: SsePhaseState }>;
  eventNames: string[];
}

export function createSseStreamSummary(): SseStreamSummary {
  return {
    eventCount: 0,
    bytes: 0,
    tokenCount: 0,
    gapCount: 0,
    gapTotalMs: 0,
    lastEventTimestamp: null,
    assembledText: '',
    progress: null,
    phaseOrder: [],
    phaseStates: {},
    eventNames: [],
  };
}

export function appendSseEventToSummary(
  summary: SseStreamSummary,
  entry: Extract<SseLogEntry, { kind: 'event' }>
): SseStreamSummary {
  const eventName = entry.event.toLowerCase();
  const gapMs =
    summary.lastEventTimestamp === null ? 0 : entry.timestamp - summary.lastEventTimestamp;
  let next: SseStreamSummary = {
    ...summary,
    eventCount: summary.eventCount + 1,
    bytes: summary.bytes + entry.data.length,
    gapCount: summary.gapCount + (summary.lastEventTimestamp === null ? 0 : 1),
    gapTotalMs: summary.gapTotalMs + gapMs,
    lastEventTimestamp: entry.timestamp,
    eventNames: summary.eventNames.includes(entry.event)
      ? summary.eventNames
      : [...summary.eventNames, entry.event].toSorted(),
  };

  if (eventName === 'token') {
    return {
      ...next,
      tokenCount: next.tokenCount + 1,
      assembledText: `${next.assembledText}${entry.data}`,
    };
  }

  if (eventName === 'message') {
    try {
      const parsed = JSON.parse(entry.data) as Record<string, unknown>;
      if (typeof parsed['token'] === 'string') {
        next = {
          ...next,
          tokenCount: next.tokenCount + 1,
          assembledText: `${next.assembledText}${parsed['token']}`,
        };
      } else if (typeof parsed['text'] === 'string') {
        next = { ...next, assembledText: `${next.assembledText}${parsed['text']}` };
      } else if (typeof parsed['delta'] === 'string') {
        next = {
          ...next,
          tokenCount: next.tokenCount + 1,
          assembledText: `${next.assembledText}${parsed['delta']}`,
        };
      }

      if (typeof parsed['phase'] === 'string') {
        const phaseOrder = next.phaseOrder.includes(parsed['phase'])
          ? next.phaseOrder
          : [...next.phaseOrder, parsed['phase']];
        const phaseStates: Record<string, SsePhaseState> = {};
        for (const phase of phaseOrder) {
          phaseStates[phase] = phase === parsed['phase'] ? 'active' : 'done';
        }
        next = { ...next, phaseOrder, phaseStates };
      }
    } catch {
      // Non-JSON message events only appear in the timeline.
    }
    return next;
  }

  if (eventName === 'progress') {
    try {
      const parsed: unknown = JSON.parse(entry.data);
      const value =
        typeof parsed === 'number'
          ? parsed
          : parsed &&
              typeof parsed === 'object' &&
              typeof (parsed as Record<string, unknown>)['progress'] === 'number'
            ? ((parsed as Record<string, unknown>)['progress'] as number)
            : parsed &&
                typeof parsed === 'object' &&
                typeof (parsed as Record<string, unknown>)['value'] === 'number'
              ? ((parsed as Record<string, unknown>)['value'] as number)
              : null;
      if (value !== null) return { ...next, progress: value > 1 ? value / 100 : value };
    } catch {
      const value = Number(entry.data);
      if (Number.isFinite(value)) return { ...next, progress: value > 1 ? value / 100 : value };
    }
    return next;
  }

  if (eventName === 'done') {
    return {
      ...next,
      progress: 1,
      phaseStates: Object.fromEntries(next.phaseOrder.map((phase) => [phase, 'done' as const])),
    };
  }

  return next;
}

export function rebuildSseStreamSummary(log: SseLogEntry[]): SseStreamSummary {
  return log.reduce(
    (summary, entry) =>
      entry.kind === 'event' ? appendSseEventToSummary(summary, entry) : summary,
    createSseStreamSummary()
  );
}

export function getSseSummaryView(summary: SseStreamSummary): SseSummaryView {
  return {
    eventCount: summary.eventCount,
    bytes: summary.bytes,
    tokenCount: summary.tokenCount,
    avgGapMs: summary.gapCount === 0 ? null : summary.gapTotalMs / summary.gapCount,
    assembledText: summary.assembledText,
    progress: summary.progress,
    phases: summary.phaseOrder.map((id) => ({
      id,
      label: id,
      state: summary.phaseStates[id] ?? 'pending',
    })),
    eventNames: summary.eventNames,
  };
}
