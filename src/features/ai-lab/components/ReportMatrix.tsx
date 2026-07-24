import { X } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Floater } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';
import { modelKey } from '../lib/modelOptions';
import { summarizeVars } from '../lib/summarizeVars';
import type { Dataset, EvalCellResult, EvalRun } from '../types';
import { labelForModel, type ModelStats } from './ReportSummary';
import { VerdictChip } from './VerdictChip';

interface ReportMatrixProps {
  run: EvalRun;
  dataset?: Dataset;
  stats: ModelStats[];
  drillCaseId: string | null;
  onDrillCaseChange: (caseId: string | null) => void;
}

/** Case-by-model verdict matrix and the selected case's result cards. */
export function ReportMatrix({
  run,
  dataset,
  stats,
  drillCaseId,
  onDrillCaseChange,
}: ReportMatrixProps) {
  const caseIds = useMemo(() => {
    const seen: string[] = [];
    const ids = new Set<string>();
    for (const cell of run.cells) {
      if (!ids.has(cell.caseId)) {
        ids.add(cell.caseId);
        seen.push(cell.caseId);
      }
    }
    return seen;
  }, [run]);
  const modelKeys = useMemo(() => stats.map((model) => model.key), [stats]);
  const cellByCaseAndModel = useMemo(() => {
    const cells = new Map<string, EvalCellResult>();
    for (const cell of run.cells) cells.set(`${cell.caseId}|${modelKey(cell.modelRef)}`, cell);
    return cells;
  }, [run]);
  const caseById = useMemo(
    () => new Map((dataset?.cases ?? []).map((item) => [item.id, item])),
    [dataset]
  );
  const caseLabel = useCallback(
    (caseId: string, index: number): string => {
      const item = caseById.get(caseId);
      if (!item) return `Case ${index + 1} (${caseId.slice(0, 8)})`;
      const vars = summarizeVars(item.vars, 2, 20);
      return vars ? `Case ${index + 1} — ${vars}` : `Case ${index + 1}`;
    },
    [caseById]
  );
  const drillCells = useMemo(
    () => (drillCaseId ? run.cells.filter((cell) => cell.caseId === drillCaseId) : []),
    [drillCaseId, run]
  );

  if (caseIds.length === 0 || modelKeys.length === 0) return null;

  return (
    <div className="space-y-2 border-t border-sp-line pt-3">
      <h3 className="sp-label">Cases × models</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sp-11">
          <thead>
            <tr className="text-left text-sp-muted">
              <th className="py-1.5 pr-3 font-medium">Case</th>
              {modelKeys.map((key) => (
                <th
                  key={key}
                  className="max-w-[9rem] truncate px-1.5 py-1.5 text-center font-medium"
                  title={labelForModel(run, key)}
                >
                  {labelForModel(run, key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {caseIds.map((caseId, index) => (
              <tr
                key={caseId}
                className={cn(
                  'cursor-pointer border-t border-sp-line transition-colors hover:bg-sp-hover',
                  drillCaseId === caseId && 'bg-[var(--sp-accent-glow-15)]'
                )}
                onClick={() => onDrillCaseChange(drillCaseId === caseId ? null : caseId)}
              >
                <td className="max-w-[18rem] truncate py-1.5 pr-3 text-sp-text">
                  {caseLabel(caseId, index)}
                </td>
                {modelKeys.map((key) => {
                  const cell = cellByCaseAndModel.get(`${caseId}|${key}`);
                  return (
                    <td key={key} className="px-1.5 py-1.5 text-center">
                      {cell ? (
                        <VerdictChip passed={cell.passed} notEvaluated={cell.notEvaluated} />
                      ) : (
                        <span className="text-sp-text-dim">·</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {drillCaseId && (
        <div className="flex items-center justify-between gap-2 pt-1">
          <h4 className="sp-label">
            {caseLabel(drillCaseId, Math.max(0, caseIds.indexOf(drillCaseId)))}
          </h4>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear case selection"
            title="Clear selection"
            onClick={() => onDrillCaseChange(null)}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {drillCells.length > 0 && (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
          {drillCells.map((cell) => {
            const key = modelKey(cell.modelRef);
            return (
              <Floater
                key={`${cell.caseId}:${key}`}
                radius="panel"
                elevation="inset"
                className="flex flex-col gap-2 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sp-12 font-medium text-sp-text">
                    {labelForModel(run, key)}
                  </span>
                  <VerdictChip passed={cell.passed} notEvaluated={cell.notEvaluated} />
                </div>
                {cell.executed && (
                  <div className="text-sp-11 text-sp-muted">
                    HTTP {cell.executed.status} · {Math.round(cell.executed.latencyMs)}ms
                  </div>
                )}
                <div className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-sp-bg p-2 text-sp-11 text-sp-text">
                  {cell.error ? (
                    <span className="text-destructive">{cell.error}</span>
                  ) : (
                    cell.output || <span className="text-sp-muted">(empty)</span>
                  )}
                </div>
                {cell.scores.length > 0 && (
                  <div className="space-y-1 border-t border-sp-line pt-1.5">
                    {cell.scores.map((score, index) => (
                      <div
                        key={index}
                        className="flex items-start justify-between gap-2 text-sp-11"
                      >
                        <span className="text-sp-muted">{score.kind}</span>
                        <span
                          className={cn(
                            'text-right',
                            score.passed ? 'text-emerald-500' : 'text-destructive'
                          )}
                        >
                          {score.passed ? 'pass' : 'fail'}
                          {score.score !== undefined ? ` (${score.score.toFixed(2)})` : ''}
                          {score.detail ? (
                            <span className="block text-sp-text-dim">{score.detail}</span>
                          ) : null}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Floater>
            );
          })}
        </div>
      )}
    </div>
  );
}
