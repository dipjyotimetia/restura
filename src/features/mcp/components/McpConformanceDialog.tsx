import type { McpConformanceReport, McpSampleCallMode } from '@shared/protocol/mcp-conformance';
import {
  conformanceReportToJson,
  conformanceReportToMarkdown,
} from '@shared/protocol/mcp-conformance-report';
import { isDestructiveTool, mcpToolDisplayName } from '@shared/protocol/mcp-tool-descriptor';
import { Download, FlaskConical } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  type McpConformanceRunInput,
  type McpConformanceRunResult,
  runMcpConformanceReport,
} from '@/features/mcp/lib/mcpConformance';
import { isElectron } from '@/lib/shared/platform';
import { cn } from '@/lib/shared/utils';
import type { McpToolDescriptor } from '@/types';

interface McpConformanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolve the connection's current endpoint (variables substituted) at run time. */
  getEndpoint: () => Pick<McpConformanceRunInput, 'url' | 'transport' | 'headers'>;
  /** Tools discovered on the live connection, if any (drives the sample-call picker). */
  tools: McpToolDescriptor[];
  /** Injectable for tests. */
  run?: (input: McpConformanceRunInput) => Promise<McpConformanceRunResult>;
}

const SAMPLE_OPTIONS: Array<{ value: McpSampleCallMode; label: string; hint: string }> = [
  { value: 'off', label: 'No tool calls', hint: 'Handshake, listings and descriptor checks only' },
  {
    value: 'read-only',
    label: 'Read-only tools',
    hint: 'Calls tools annotated readOnlyHint with minimal arguments',
  },
  {
    value: 'selected',
    label: 'Read-only + chosen tools',
    hint: 'Also calls the non-destructive tools you tick below',
  },
];

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const SEVERITY_STYLE = {
  error: 'text-[var(--color-danger)]',
  warning: 'text-[var(--color-warning)]',
  info: 'text-sp-muted',
} as const;

function ReportView({ report }: { report: McpConformanceReport }) {
  const { errors, warnings, info } = report.summary;
  return (
    <div className="flex flex-col gap-3 text-sp-12" data-testid="conformance-report">
      <p>
        <strong>{errors}</strong> error(s), <strong>{warnings}</strong> warning(s),{' '}
        <strong>{info}</strong> note(s)
      </p>
      <table className="w-full text-left">
        <thead>
          <tr className="sp-label">
            <th>Era</th>
            <th>Status</th>
            <th>Protocol</th>
            <th>Tools</th>
            <th>Resources</th>
            <th>Prompts</th>
          </tr>
        </thead>
        <tbody>
          {report.eras.map((e) => (
            <tr key={e.era} className="font-mono">
              <td>{e.era}</td>
              <td>{e.status}</td>
              <td>{e.protocolVersion ?? '-'}</td>
              <td>{e.listing.tools.length}</td>
              <td>{e.listing.resources.length}</td>
              <td>{e.listing.prompts.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {report.diff ? (
        <p data-testid="conformance-diff">
          Era diff: {report.findings.filter((f) => f.era === 'cross-era').length} difference(s)
          between legacy and modern.
        </p>
      ) : (
        <p className="text-sp-muted">No era diff: both eras must connect to compare them.</p>
      )}
      {report.findings.length === 0 ? (
        <p>No findings.</p>
      ) : (
        <ul className="flex flex-col gap-1 max-h-60 overflow-auto" aria-label="Findings">
          {report.findings.map((f, i) => (
            <li key={`${f.era}-${f.code}-${f.subject ?? ''}-${i}`} className="font-mono">
              <span className={cn('uppercase mr-1.5', SEVERITY_STYLE[f.severity])}>
                {f.severity}
              </span>
              <span className="text-sp-dim mr-1.5">[{f.era}]</span>
              {f.subject && <span className="mr-1.5">{f.subject}:</span>}
              {f.message}
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            download('mcp-conformance.md', conformanceReportToMarkdown(report), 'text/markdown')
          }
        >
          <Download className="h-3.5 w-3.5" />
          Export Markdown
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            download('mcp-conformance.json', conformanceReportToJson(report), 'application/json')
          }
        >
          <Download className="h-3.5 w-3.5" />
          Export JSON
        </Button>
      </div>
    </div>
  );
}

/** MCP era/conformance report (#911): run, review and export. */
export function McpConformanceDialog({
  open,
  onOpenChange,
  getEndpoint,
  tools,
  run = runMcpConformanceReport,
}: McpConformanceDialogProps) {
  const [mode, setMode] = useState<McpSampleCallMode>('off');
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<McpConformanceReport | null>(null);

  // Destructive tools are never offered: the engine refuses them regardless.
  const candidates = tools.filter(
    (t) => t.annotations?.readOnlyHint !== true && !isDestructiveTool(t)
  );

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    setReport(null);
    const result = await run({
      ...getEndpoint(),
      sampleCalls: mode,
      approvedTools: mode === 'selected' ? [...approved] : [],
    });
    setRunning(false);
    if (result.ok) setReport(result.report);
    else setError(result.error);
  };

  const toggle = (name: string) =>
    setApproved((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-auto">
        <DialogHeader icon={FlaskConical}>
          <DialogTitle>MCP conformance report</DialogTitle>
          <DialogDescription>
            Connects in the legacy (initialize) and modern (2026-07-28) protocol eras, checks
            handshake, listings and structured output, and diffs the two.
            {!isElectron() &&
              ' The web app can only exercise the legacy era; use the desktop app or CLI for both.'}
          </DialogDescription>
        </DialogHeader>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="sp-label mb-1">Sample tool calls</legend>
          {SAMPLE_OPTIONS.map((o) => (
            <label key={o.value} className="flex items-start gap-2 text-sp-12">
              <input
                type="radio"
                name="conformance-sample-mode"
                checked={mode === o.value}
                onChange={() => setMode(o.value)}
                className="mt-0.5"
              />
              <span>
                {o.label}
                <span className="block text-sp-dim">{o.hint}</span>
              </span>
            </label>
          ))}
          {mode === 'selected' && (
            <div className="ml-6 mt-1 flex flex-col gap-1" aria-label="Tools to call">
              {candidates.length === 0 ? (
                <p className="text-sp-12 text-sp-dim">
                  Connect and discover tools first to choose which to call.
                </p>
              ) : (
                candidates.map((t) => (
                  <label key={t.name} className="flex items-center gap-2 text-sp-12 font-mono">
                    <input
                      type="checkbox"
                      checked={approved.has(t.name)}
                      onChange={() => toggle(t.name)}
                    />
                    {mcpToolDisplayName(t)}
                  </label>
                ))
              )}
              <p className="text-sp-12 text-sp-dim">
                Destructive tools are never called. Annotations are server-provided hints, so only
                tick tools you trust.
              </p>
            </div>
          )}
        </fieldset>

        <div>
          <Button variant="cta" size="cta" onClick={handleRun} loading={running}>
            Run conformance check
          </Button>
        </div>

        {error && (
          <div role="alert" className="text-sp-12 text-[var(--color-danger)]">
            {error}
          </div>
        )}
        {report && <ReportView report={report} />}
      </DialogContent>
    </Dialog>
  );
}
