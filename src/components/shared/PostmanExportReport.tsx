import type { PostmanExportReport } from '@shared/collections/postman';
import { toast } from 'sonner';

const MAX_LISTED = 8;

/** The export report as a short list (names + fixed notes only — never values). */
export function PostmanExportReportList({ report }: { report: PostmanExportReport }) {
  const shown = report.entries.slice(0, MAX_LISTED);
  const more = report.entries.length - shown.length;
  return (
    <ul
      className="space-y-1 text-sp-12 max-h-40 overflow-y-auto pr-1"
      data-testid="postman-export-report"
    >
      {shown.map((entry, index) => (
        <li key={index} className="flex gap-2">
          <span className="text-amber-400/70 shrink-0">›</span>
          <span>
            {entry.detail} (&quot;{entry.itemName}&quot;)
          </span>
        </li>
      ))}
      {more > 0 && <li className="italic">… and {more} more</li>}
    </ul>
  );
}

/**
 * Tell the user what a Postman v3 or v2.1 export left out (SSE / non-HTTP requests, WSSE auth,
 * emptied secrets, Restura-only settings, …). Mirrors the import banner's
 * warning list, as a toast because export has no dialog of its own.
 */
export function showPostmanExportReport(report: PostmanExportReport, success: string): void {
  if (report.entries.length === 0) {
    toast.success(success);
    return;
  }
  const n = report.entries.length;
  toast.warning(`${success} — ${n} item${n === 1 ? '' : 's'} not exported as-is`, {
    description: <PostmanExportReportList report={report} />,
    duration: 15_000,
  });
}
