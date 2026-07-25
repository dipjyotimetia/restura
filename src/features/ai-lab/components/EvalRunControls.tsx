import { Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Stat } from '@/components/ui/spatial';
import type { EvalProgress } from '../lib/evalRunner';
import { StatusChip } from './StatusChip';

interface EvalRunControlsProps {
  running: boolean;
  progress: EvalProgress | null;
  error: string | null;
  persistenceError: string | null;
  lastRunId: string | null;
  hasPendingReport: boolean;
  passCount: number;
  runDisabledReason: string | null;
  onRun: () => void;
  onStop: () => void;
  onRetrySave: () => void;
  onOpenReport: (runId: string) => void;
}

/** Run controls and persisted progress for the module-scoped eval lifecycle. */
export function EvalRunControls({
  running,
  progress,
  error,
  persistenceError,
  lastRunId,
  hasPendingReport,
  passCount,
  runDisabledReason,
  onRun,
  onStop,
  onRetrySave,
  onOpenReport,
}: EvalRunControlsProps) {
  return (
    <div className="mt-4 space-y-2 border-t border-sp-line pt-4">
      {running ? (
        <Button variant="destructive" size="cta" onClick={onStop} className="w-full">
          <Square className="h-3.5 w-3.5" /> Stop
        </Button>
      ) : (
        <Button
          variant="cta"
          size="cta"
          onClick={onRun}
          disabled={runDisabledReason !== null}
          className="w-full"
          title="Cmd/Ctrl+Enter"
        >
          <Play className="h-3.5 w-3.5" /> Run eval
        </Button>
      )}
      {!running && runDisabledReason && (
        <p className="text-sp-11 text-sp-muted">{runDisabledReason}</p>
      )}
      {error && <p className="text-sp-12 text-destructive">{error}</p>}
      {persistenceError && <p className="text-sp-12 text-destructive">{persistenceError}</p>}
      {hasPendingReport && (
        <Button variant="outline" size="sm" className="w-full" onClick={onRetrySave}>
          Retry report save
        </Button>
      )}
      {progress && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <StatusChip state={progress.done ? 'done' : 'running'} />
            <div className="flex gap-6">
              <Stat label="Cells" value={`${progress.completed}/${progress.total}`} />
              <Stat label="Passed" value={passCount} />
            </div>
          </div>
          <Progress value={(progress.completed / Math.max(1, progress.total)) * 100} />
          {progress.done && lastRunId && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => onOpenReport(lastRunId)}
            >
              View report
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
