import { formatRelativeTime } from '@/lib/shared/console-format';
import { cn } from '@/lib/shared/utils';
import type { AiLabReportEnvelope } from '../run-engine/reportEnvelope';
import { StatusChip } from './StatusChip';

interface ReportRunListProps {
  reports: AiLabReportEnvelope[];
  selectedId?: string;
  onSelect: (reportId: string) => void;
}

/** Master pane for the persisted and in-memory evaluation reports. */
export function ReportRunList({ reports, selectedId, onSelect }: ReportRunListProps) {
  return (
    <div className="flex flex-1 flex-col gap-2 overflow-auto p-3">
      {reports.map((report) => (
        <button
          key={report.id}
          onClick={() => onSelect(report.id)}
          className={cn(
            'w-full rounded-sp-btn border px-3 py-2.5 text-left transition-colors',
            selectedId === report.id
              ? 'border-sp-accent bg-[var(--sp-accent-glow-15)]'
              : 'border-sp-line hover:bg-sp-hover'
          )}
        >
          <div className="truncate text-sp-13 text-sp-text">{report.name}</div>
          <div className="mt-0.5 truncate text-sp-11 text-sp-muted">
            {formatRelativeTime(report.startedAt)}
            {report.kind === 'eval' && report.payload.datasetName
              ? ` · ${report.payload.datasetName}`
              : report.kind === 'agent-suite'
                ? ' · Agent suite'
                : ''}
          </div>
          <div className="mt-1 flex items-center justify-between">
            <StatusChip state={report.status} />
            <span className="text-sp-11 text-sp-muted tabular-nums">
              {report.kind === 'eval'
                ? `${report.payload.cells.length}/${report.payload.totalCells}`
                : `${report.payload.summary.passed}/${report.payload.summary.total}`}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}
