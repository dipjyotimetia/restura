import { Bug, ClipboardCheck, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { buildBugReportMarkdown, type BugReportDiagnostics } from '@/lib/shared/bug-report';

export interface BugReportScreenshot {
  imageDataUrl: string;
}

export interface BugReportSubmission {
  title: string;
  description: string;
  steps: string;
  expected: string;
  actual: string;
  diagnostics?: BugReportDiagnostics;
  screenshot?: BugReportScreenshot;
}

interface BugReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  diagnostics?: BugReportDiagnostics;
  screenshot?: BugReportScreenshot;
  captureError?: string;
  diagnosticsError?: string;
  onOpenGitHubDraft: (submission: BugReportSubmission) => void | Promise<void>;
}

export function BugReportDialog({
  open,
  onOpenChange,
  diagnostics,
  screenshot,
  captureError,
  diagnosticsError,
  onOpenGitHubDraft,
}: BugReportDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');
  const [expected, setExpected] = useState('');
  const [actual, setActual] = useState('');
  const [includeScreenshot, setIncludeScreenshot] = useState(Boolean(screenshot));
  const [includeDiagnostics, setIncludeDiagnostics] = useState(Boolean(diagnostics));
  const [validationError, setValidationError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setIncludeScreenshot(Boolean(screenshot));
      setIncludeDiagnostics(Boolean(diagnostics));
      setValidationError('');
    }
  }, [open, screenshot, diagnostics]);

  const handleOpenDraft = async () => {
    if (!title.trim() || !description.trim()) {
      setValidationError('A title and description are required before opening the GitHub draft.');
      return;
    }

    setValidationError('');
    setSubmitting(true);
    try {
      await onOpenGitHubDraft({
        title: title.trim(),
        description: description.trim(),
        steps,
        expected,
        actual,
        ...(includeDiagnostics && diagnostics ? { diagnostics } : {}),
        ...(includeScreenshot && screenshot ? { screenshot } : {}),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader icon={Bug} tone="warning">
          <DialogTitle>Report a bug</DialogTitle>
          <DialogDescription>
            Review what will be shared before Restura opens a GitHub issue draft.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-sp-btn border border-amber-500/30 bg-amber-500/8 px-3 py-2.5 text-xs text-sp-muted">
            <div className="flex gap-2">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
              <p>
                Do not include credentials, private data, or security vulnerabilities. Report
                security issues privately through GitHub Security Advisories.
              </p>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="bug-report-title">Title</Label>
            <Input
              id="bug-report-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Short summary of the problem"
              maxLength={140}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="bug-report-description">Description</Label>
            <Textarea
              id="bug-report-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What happened, and when did it start?"
              maxLength={4_000}
              className="min-h-24"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="bug-report-steps">Steps to reproduce</Label>
              <Textarea
                id="bug-report-steps"
                value={steps}
                onChange={(event) => setSteps(event.target.value)}
                placeholder="1. …"
                className="min-h-24 text-sm"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="bug-report-expected">Expected behavior</Label>
              <Textarea
                id="bug-report-expected"
                value={expected}
                onChange={(event) => setExpected(event.target.value)}
                placeholder="What should happen?"
                className="min-h-24 text-sm"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="bug-report-actual">Actual behavior</Label>
              <Textarea
                id="bug-report-actual"
                value={actual}
                onChange={(event) => setActual(event.target.value)}
                placeholder="What happened instead?"
                className="min-h-24 text-sm"
              />
            </div>
          </div>

          <div className="rounded-sp-btn border border-sp-line bg-sp-surface-lo p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <Label htmlFor="include-screenshot" className="text-sm text-sp-text">
                  Include screenshot
                </Label>
                <p className="mt-1 text-xs text-sp-muted">
                  {screenshot
                    ? 'It will be copied to your clipboard so you can paste it into GitHub.'
                    : captureError || 'No screenshot was captured.'}
                </p>
              </div>
              <Checkbox
                id="include-screenshot"
                checked={includeScreenshot}
                onCheckedChange={(checked) => setIncludeScreenshot(checked === true)}
                disabled={!screenshot}
                aria-label="Include screenshot"
              />
            </div>
            {includeScreenshot && screenshot && (
              <img
                src={screenshot.imageDataUrl}
                alt="Captured bug report screenshot"
                className="max-h-44 w-full rounded border border-sp-line object-contain bg-black"
              />
            )}
          </div>

          <div className="rounded-sp-btn border border-sp-line bg-sp-surface-lo p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <Label htmlFor="include-diagnostics" className="text-sm text-sp-text">
                  Include redacted diagnostics
                </Label>
                <p className="mt-1 text-xs text-sp-muted">
                  {diagnostics
                    ? `${diagnostics.runtimeErrors.length} recent runtime error${diagnostics.runtimeErrors.length === 1 ? '' : 's'}${diagnostics.requestLogs?.length ? ` and ${diagnostics.requestLogs.length} request records` : ''}.`
                    : diagnosticsError || 'Diagnostics were unavailable.'}
                </p>
              </div>
              <Checkbox
                id="include-diagnostics"
                checked={includeDiagnostics}
                onCheckedChange={(checked) => setIncludeDiagnostics(checked === true)}
                disabled={!diagnostics}
                aria-label="Include diagnostics"
              />
            </div>
            {diagnostics && (
              <details className="mt-3 rounded border border-sp-line bg-sp-surface-hi px-2.5 py-2">
                <summary className="cursor-pointer text-xs font-medium text-sp-text">
                  Preview diagnostics
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-sp-muted">
                  {buildBugReportMarkdown({ title: '', description: '', diagnostics })
                    .split('## 🚨 Error Logs')[1]
                    ?.split('## 📝 Additional Context')[0]
                    ?.trim()}
                </pre>
              </details>
            )}
          </div>
          {validationError && (
            <p className="text-sm text-destructive" role="alert">
              {validationError}
            </p>
          )}
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <p className="flex items-center gap-1.5 text-xs text-sp-muted">
            <ClipboardCheck className="size-3.5" aria-hidden="true" />
            GitHub opens a draft; you review and submit it.
          </p>
          <Button
            variant="cta"
            size="cta"
            onClick={() => void handleOpenDraft()}
            loading={submitting}
          >
            Open GitHub draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
