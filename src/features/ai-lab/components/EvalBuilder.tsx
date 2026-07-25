import { memo, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { useConfirmDialog } from '@/components/shared/ConfirmDialog';
import ResizableLayout from '@/components/shared/ResizableLayout';
import { Floater } from '@/components/ui/spatial';
import { useCmdEnterRun } from '../hooks/useCmdEnterRun';
import { useEvalRun } from '../hooks/useEvalRun';
import { useModelSelection } from '../hooks/useModelSelection';
import { modelKey } from '../lib/modelOptions';
import { useAiLabStore } from '../store/useAiLabStore';
import { useAiLabUiStore } from '../store/useAiLabUiStore';
import type { EvalCellResult, EvalConfig, EvalTarget, ModelRef, ScorerConfig } from '../types';
import { EvalDraftEditor } from './EvalDraftEditor';
import { EvalRunControls } from './EvalRunControls';
import { SCORER_LABEL, ScorerEditor } from './ScorerEditor';
import { VerdictChip } from './VerdictChip';

function targetFor(mode: 'text' | 'http' | 'graphql'): EvalTarget {
  if (mode === 'text') return { kind: 'text' };
  return { kind: 'http-exec', parseFrom: 'fenced', protocol: mode };
}

function targetModeOf(target: EvalTarget | undefined): 'text' | 'http' | 'graphql' {
  if (target?.kind === 'http-exec') return target.protocol;
  return 'text';
}

export function EvalBuilder() {
  const providers = useAiLabStore((state) => state.providers);
  const datasets = useAiLabStore((state) => state.datasets);
  const evalConfigs = useAiLabStore((state) => state.evalConfigs);
  const prompts = useAiLabStore((state) => state.prompts);
  const upsertPrompt = useAiLabStore((state) => state.upsertPrompt);
  const upsertEvalConfig = useAiLabStore((state) => state.upsertEvalConfig);
  const removeEvalConfig = useAiLabStore((state) => state.removeEvalConfig);
  const {
    running,
    progress,
    error,
    persistenceError,
    lastRunId,
    pendingReport,
    start,
    stop,
    retrySave,
  } = useEvalRun();

  // The whole builder form is a session-scoped draft: sub-tabs unmount on
  // switch and losing five configured scorers to a glance at Datasets was the
  // single worst trap in this tab.
  const draft = useAiLabUiStore((state) => state.evalDraft);
  const patchDraft = useAiLabUiStore((state) => state.patchEvalDraft);
  const setDraft = useAiLabUiStore((state) => state.setEvalDraft);
  const newDraft = useAiLabUiStore((state) => state.newEvalDraft);
  const openReport = useAiLabUiStore((state) => state.openReport);
  const setTab = useAiLabUiStore((state) => state.setTab);

  // The saved config this draft points at, if it still exists (drives the
  // Select value, the delete affordance, and the confirm copy).
  const savedConfig = evalConfigs[draft.configId];
  const { confirm: confirmDeleteConfig, DialogComponent: DeleteConfigDialog } = useConfirmDialog({
    title: 'Delete saved eval',
    description: `Delete the saved eval "${savedConfig?.name ?? draft.name}"? Past runs in Reports are kept.`,
    confirmText: 'Delete',
    variant: 'destructive',
  });

  const onSelectionChange = useCallback(
    (selected: string[]) => patchDraft({ selected }),
    [patchDraft]
  );
  const { modelOptions, checklistEntries, selectedSet, toggle, setSelected } = useModelSelection(
    providers,
    draft.selected,
    onSelectionChange
  );
  const scorers = draft.scorers;
  const setScorers = (next: ScorerConfig[]) => patchDraft({ scorers: next });
  const savedConfigs = useMemo(
    () => Object.values(evalConfigs).sort((a, b) => b.updatedAt - a.updatedAt),
    [evalConfigs]
  );
  const firstModelRef = modelOptions[0]
    ? { providerConfigId: modelOptions[0].cfg.id, model: modelOptions[0].model }
    : undefined;

  /** Populate the draft from a saved eval config (prompt text included). */
  const loadConfig = (config: EvalConfig) => {
    const prompt = prompts[config.promptId];
    setDraft({
      configId: config.id,
      name: config.name,
      system: prompt?.system ?? '',
      user: prompt?.user ?? '',
      datasetId: config.datasetId,
      selected: config.models.map(modelKey),
      scorers: config.scorers,
      concurrency: config.concurrency,
      targetMode: targetModeOf(config.target),
    });
  };

  const deleteConfig = async () => {
    if (!savedConfig || !(await confirmDeleteConfig())) return;
    removeEvalConfig(draft.configId);
    newDraft();
  };

  // Judge and pairwise scorers carry their own judge model. An unset value
  // must be rejected here rather than becoming a per-cell judge-call error.
  const unconfiguredJudgeScorer = scorers.find(
    (scorer) =>
      (scorer.kind === 'judge' || scorer.kind === 'pairwise') &&
      (!scorer.judgeModel.providerConfigId || !scorer.judgeModel.model)
  );

  const run = () => {
    if (!draft.datasetId) {
      toast.error('Pick a dataset.');
      return;
    }
    const models: ModelRef[] = modelOptions
      .filter((model) => selectedSet.has(model.key))
      .map((model) => ({ providerConfigId: model.cfg.id, model: model.model }));
    if (models.length === 0) {
      toast.error('Select at least one model.');
      return;
    }
    if (unconfiguredJudgeScorer) {
      toast.error(
        `Pick a judge model for the ${SCORER_LABEL[unconfiguredJudgeScorer.kind]} scorer.`
      );
      return;
    }
    const promptId = upsertPrompt({
      name: `${draft.name} prompt`,
      system: draft.system,
      user: draft.user,
    });
    const config: EvalConfig = {
      id: draft.configId,
      name: draft.name,
      promptId,
      datasetId: draft.datasetId,
      models,
      scorers,
      concurrency: draft.concurrency,
      target: targetFor(draft.targetMode),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    upsertEvalConfig(config);
    start(config);
  };

  const passCount = useMemo(
    () => progress?.cells.reduce((count, cell) => count + (cell.passed ? 1 : 0), 0) ?? 0,
    [progress]
  );
  const canRun = !!draft.datasetId && selectedSet.size > 0 && !unconfiguredJudgeScorer && !running;
  const runDisabledReason = !draft.datasetId
    ? 'Pick a dataset to run.'
    : selectedSet.size === 0
      ? 'Select at least one model.'
      : unconfiguredJudgeScorer
        ? `Pick a judge model for the ${SCORER_LABEL[unconfiguredJudgeScorer.kind]} scorer.`
        : null;

  useCmdEnterRun(() => {
    if (canRun) run();
  });

  const labelByModel = useMemo(
    () => Object.fromEntries(modelOptions.map((model) => [model.key, model.label])),
    [modelOptions]
  );

  return (
    <>
      <ResizableLayout defaultSplit={34} minSplit={24} maxSplit={55}>
        <div className="flex-1 overflow-auto p-4">
          <EvalDraftEditor
            draft={draft}
            savedConfig={savedConfig}
            savedConfigs={savedConfigs}
            evalConfigs={evalConfigs}
            datasets={datasets}
            checklistEntries={checklistEntries}
            selectedSet={selectedSet}
            onPatchDraft={patchDraft}
            onLoadConfig={loadConfig}
            onNew={newDraft}
            onDelete={() => void deleteConfig()}
            onToggleModel={toggle}
            onChangeSelectedModels={setSelected}
            onOpenModels={() => setTab('providers')}
          />
          <EvalRunControls
            running={running}
            progress={progress}
            error={error}
            persistenceError={persistenceError}
            lastRunId={lastRunId}
            hasPendingReport={!!pendingReport}
            passCount={passCount}
            runDisabledReason={runDisabledReason}
            onRun={run}
            onStop={stop}
            onRetrySave={() => void retrySave()}
            onOpenReport={openReport}
          />
        </div>
        <div className="flex flex-1 flex-col overflow-auto p-4">
          <ScorerEditor
            scorers={scorers}
            modelOptions={modelOptions}
            firstModelRef={firstModelRef}
            onChange={setScorers}
          />
          {progress && progress.cells.length > 0 && (
            <div className="mt-4 space-y-2 border-t border-sp-line pt-4">
              <span className="sp-label">Live results</span>
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
                {progress.cells.map((cell) => {
                  const key = modelKey(cell.modelRef);
                  return (
                    <LiveCellCard
                      key={`${cell.caseId}:${key}`}
                      cell={cell}
                      label={labelByModel[key] ?? cell.modelRef.model}
                    />
                  );
                })}
              </div>
            </div>
          )}
          {!progress && (
            <Floater
              radius="panel"
              elevation="inset"
              className="mt-4 px-3 py-6 text-center text-sp-12 text-sp-muted"
            >
              Configure the eval on the left and run it to watch results stream in here.
            </Floater>
          )}
        </div>
      </ResizableLayout>
      <DeleteConfigDialog />
    </>
  );
}

/**
 * One live-result card. Memoized because the grid re-renders every progress
 * tick with ALL completed cells — without this, C completed cells cost O(C²)
 * card renders over a run. Cell objects are append-only (the runner never
 * mutates completed entries), so memo comparison is safe and effective.
 */
const LiveCellCard = memo(function LiveCellCard({
  cell,
  label,
}: {
  cell: EvalCellResult;
  label: string;
}) {
  return (
    <Floater radius="panel" elevation="inset" className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sp-12 font-medium text-sp-text">{label}</span>
        <VerdictChip passed={cell.passed} notEvaluated={cell.notEvaluated} />
      </div>
      <div className="text-sp-11 text-sp-muted tabular-nums">{Math.round(cell.latencyMs)}ms</div>
      <div className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-sp-bg p-2 text-sp-11 text-sp-text">
        {cell.error ? (
          <span className="text-destructive">{cell.error}</span>
        ) : (
          cell.output || <span className="text-sp-muted">(empty)</span>
        )}
      </div>
    </Floater>
  );
});
