import { formatRelativeTime } from '@/lib/shared/console-format';
import { cn } from '@/lib/shared/utils';
import { type AiLabReportEnvelope, reportChipState } from '../run-engine/reportEnvelope';
import { StatusChip } from './StatusChip';

interface ReportRunListProps {
  reports: AiLabReportEnvelope[];
  selectedId?: string;
  onSelect: (reportId: string) => void;
}

function reportCount(report: AiLabReportEnvelope): string {
  switch (report.kind) {
    case 'eval':
      return `${report.payload.cells.length}/${report.payload.totalCells}`;
    case 'agent-suite':
      return `${report.payload.summary.passed}/${report.payload.summary.total}`;
    case 'arena': {
      const scored = report.payload.matches.filter((m) => m.winner !== 'error').length;
      return `${scored}/${report.payload.matches.length}`;
    }
  }
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
                : report.kind === 'arena'
                  ? ` · ${report.payload.modelKeys.length} models`
                  : ''}
          </div>
          <div className="mt-1 flex items-center justify-between">
            <StatusChip
              state={reportChipState(report)}
              {...(report.statusReason
                ? { label: `${report.status}: ${report.statusReason}` }
                : {})}
            />
            <span className="text-sp-11 text-sp-muted tabular-nums">{reportCount(report)}</span>
          </div>
        </button>
      ))}
    </div>
  );
}
