import { WaterfallBar } from '@/components/ui/spatial';
import { SEGMENT_HELP, type TimingSegment } from '@/lib/shared/responseTimingSegments';
import { formatTime } from '@/lib/shared/utils';

/** Timeline tab: the waterfall plus one row per phase with its duration. */
export function TimingBreakdown({ segments, total }: { segments: TimingSegment[]; total: number }) {
  return (
    <div>
      <div className="sp-label mb-2">Timing</div>
      <div className="flex items-center gap-3 mb-3">
        <WaterfallBar segments={segments} width={320} height={10} />
        <span className="font-mono text-sp-12 text-sp-text tabular-nums">{formatTime(total)}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1.5 items-center max-w-lg">
        {segments.map((s) => (
          <div key={s.label} className="contents">
            <dt className="flex items-center gap-2 font-mono text-sp-12 text-sp-text">
              <span
                aria-hidden="true"
                className="inline-block size-2 rounded-full"
                style={{ background: s.color }}
              />
              {s.label}
            </dt>
            <dd className="text-sp-11-5 text-sp-dim">{SEGMENT_HELP[s.label] ?? ''}</dd>
            <dd className="font-mono text-sp-12 text-sp-muted tabular-nums text-right">
              {s.ms < 1 ? '<1ms' : formatTime(s.ms)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
