import { AlertTriangle, FilePlus2, Play, Plus, Square, Trash2, X } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';
import { useCmdEnterRun } from '../hooks/useCmdEnterRun';
import { useEvalRun } from '../hooks/useEvalRun';
import {
  buildModelOptions,
  modelKey,
  parseModelKey,
  toChecklistEntries,
  toggleKey,
  type ModelOption,
} from '../lib/modelOptions';
import { useAiLabStore } from '../store/useAiLabStore';
import { useAiLabUiStore, type EvalTargetMode } from '../store/useAiLabUiStore';
import type { EvalConfig, EvalTarget, ModelRef, ScorerConfig, ScorerKind } from '../types';
import { ModelChecklist } from './ModelChecklist';
import { StatusChip } from './StatusChip';
import { VerdictChip } from './VerdictChip';
import { useConfirmDialog } from '@/components/shared/ConfirmDialog';
import ResizableLayout from '@/components/shared/ResizableLayout';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Floater, Stat, Stepper } from '@/components/ui/spatial';
import { Textarea } from '@/components/ui/textarea';

function targetFor(mode: EvalTargetMode): EvalTarget {
  if (mode === 'text') return { kind: 'text' };
  return { kind: 'http-exec', parseFrom: 'fenced', protocol: mode };
}

function targetModeOf(target: EvalTarget | undefined): EvalTargetMode {
  if (target?.kind === 'http-exec') return target.protocol;
  return 'text';
}

const SCORER_KINDS: Array<{ kind: ScorerKind; label: string }> = [
  { kind: 'contains', label: 'Contains text' },
  { kind: 'regex', label: 'Regex match' },
  { kind: 'exact-match', label: 'Exact match' },
  { kind: 'json-valid', label: 'Valid JSON' },
  { kind: 'json-schema', label: 'JSON schema' },
  { kind: 'latency', label: 'Latency under (ms)' },
  { kind: 'cost', label: 'Cost under (USD)' },
  { kind: 'script', label: 'Script (pm.test)' },
  { kind: 'judge', label: 'LLM-as-judge' },
  { kind: 'tool-call', label: 'Tool call' },
  { kind: 'pairwise', label: 'Pairwise (vs reference)' },
];

const SCORER_LABEL: Record<ScorerKind, string> = Object.fromEntries(
  SCORER_KINDS.map((s) => [s.kind, s.label])
) as Record<ScorerKind, string>;

function defaultScorer(kind: ScorerKind, judgeModel: ModelRef | undefined): ScorerConfig {
  const id = uuidv4();
  switch (kind) {
    case 'contains':
      return { id, kind, needle: '' };
    case 'regex':
      return { id, kind, pattern: '' };
    case 'exact-match':
      return { id, kind, expectedFrom: 'expected' };
    case 'json-valid':
      return { id, kind };
    case 'json-schema':
      return { id, kind, schema: '{\n  "type": "object"\n}' };
    case 'latency':
      return { id, kind, maxMs: 5000 };
    case 'cost':
      return { id, kind, maxUSD: 0.01 };
    case 'script':
      return {
        id,
        kind,
        // The model output is exposed as pm.response.text() (the synthetic
        // response wraps it as the body); pm.response.body is not the string.
        code: "pm.test('non-empty', () => pm.expect(pm.response.text().length).to.be.above(0));",
      };
    case 'judge':
      return {
        id,
        kind,
        judgeModel: judgeModel ?? { providerConfigId: '', model: '' },
        criteria: [
          { name: 'correctness', rubric: 'Is the answer correct and complete?', weight: 1 },
        ],
        passThreshold: 0.7,
        samples: 1,
      };
    case 'tool-call':
      return { id, kind, expectedTool: '', argsSchema: '' };
    case 'pairwise':
      return {
        id,
        kind,
        judgeModel: judgeModel ?? { providerConfigId: '', model: '' },
        baseline: 'reference',
        passThreshold: 0.5,
        swapPositions: true,
      };
  }
}

export function EvalBuilder() {
  const providers = useAiLabStore((s) => s.providers);
  const datasets = useAiLabStore((s) => s.datasets);
  const evalConfigs = useAiLabStore((s) => s.evalConfigs);
  const prompts = useAiLabStore((s) => s.prompts);
  const upsertPrompt = useAiLabStore((s) => s.upsertPrompt);
  const upsertEvalConfig = useAiLabStore((s) => s.upsertEvalConfig);
  const removeEvalConfig = useAiLabStore((s) => s.removeEvalConfig);
  const { running, progress, error, lastRunId, start, stop } = useEvalRun();

  // The whole builder form is a session-scoped draft: sub-tabs unmount on
  // switch and losing five configured scorers to a glance at Datasets was the
  // single worst trap in this tab.
  const draft = useAiLabUiStore((s) => s.evalDraft);
  const patchDraft = useAiLabUiStore((s) => s.patchEvalDraft);
  const setDraft = useAiLabUiStore((s) => s.setEvalDraft);
  const newDraft = useAiLabUiStore((s) => s.newEvalDraft);
  const openReport = useAiLabUiStore((s) => s.openReport);

  const { confirm: confirmDeleteConfig, DialogComponent: DeleteConfigDialog } = useConfirmDialog({
    title: 'Delete saved eval',
    description: `Delete the saved eval "${evalConfigs[draft.configId]?.name ?? draft.name}"? Past runs in Reports are kept.`,
    confirmText: 'Delete',
    variant: 'destructive',
  });

  const modelOptions = useMemo(() => buildModelOptions(providers), [providers]);
  // Memoized + stable callbacks so the memoized ModelChecklist skips the
  // ~10 renders/sec this component does while a run streams progress.
  const checklistEntries = useMemo(() => toChecklistEntries(modelOptions), [modelOptions]);
  const selected = useMemo(() => new Set(draft.selected), [draft.selected]);
  const toggle = useCallback(
    (key: string) => patchDraft({ selected: toggleKey(draft.selected, key) }),
    [draft.selected, patchDraft]
  );
  const setSelected = useCallback(
    (next: Set<string>) => patchDraft({ selected: [...next] }),
    [patchDraft]
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

  const updateScorer = (id: string, patch: Partial<ScorerConfig>) =>
    setScorers(scorers.map((s) => (s.id === id ? ({ ...s, ...patch } as ScorerConfig) : s)));

  /** Populate the draft from a saved eval config (prompt text included). */
  const loadConfig = (cfg: EvalConfig) => {
    const prompt = prompts[cfg.promptId];
    setDraft({
      configId: cfg.id,
      name: cfg.name,
      system: prompt?.system ?? '',
      user: prompt?.user ?? '',
      datasetId: cfg.datasetId,
      selected: cfg.models.map(modelKey),
      scorers: cfg.scorers,
      concurrency: cfg.concurrency,
      targetMode: targetModeOf(cfg.target),
    });
  };

  const deleteConfig = async () => {
    if (!evalConfigs[draft.configId]) return;
    if (!(await confirmDeleteConfig())) return;
    removeEvalConfig(draft.configId);
    newDraft();
  };

  // judge/pairwise scorers carry their own judge model — an unset one
  // (providerConfigId/model both empty, the defaultScorer() fallback) would
  // otherwise only surface as a per-cell judge-call error mid-run.
  const unconfiguredJudgeScorer = scorers.find(
    (s) =>
      (s.kind === 'judge' || s.kind === 'pairwise') &&
      (!s.judgeModel.providerConfigId || !s.judgeModel.model)
  );

  const run = () => {
    if (!draft.datasetId) {
      toast.error('Pick a dataset.');
      return;
    }
    const models: ModelRef[] = modelOptions
      .filter((m) => selected.has(m.key))
      .map((m) => ({ providerConfigId: m.cfg.id, model: m.model }));
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
    () => progress?.cells.reduce((n, c) => n + (c.passed ? 1 : 0), 0) ?? 0,
    [progress]
  );

  const canRun = !!draft.datasetId && selected.size > 0 && !unconfiguredJudgeScorer && !running;
  const runDisabledReason = !draft.datasetId
    ? 'Pick a dataset to run.'
    : selected.size === 0
      ? 'Select at least one model.'
      : unconfiguredJudgeScorer
        ? `Pick a judge model for the ${SCORER_LABEL[unconfiguredJudgeScorer.kind]} scorer.`
        : null;

  useCmdEnterRun(() => {
    if (canRun) run();
  });

  // Ordered model label lookup for the live results grid.
  const labelByModel = useMemo(
    () => Object.fromEntries(modelOptions.map((m) => [m.key, m.label])),
    [modelOptions]
  );

  return (
    <>
      <ResizableLayout defaultSplit={34} minSplit={24} maxSplit={55}>
        {/* Config pane — readable measure; scrolls independently. */}
        <div className="flex-1 overflow-auto p-4">
          <div className="space-y-4">
            {savedConfigs.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="eval-saved" className="sp-label">
                  Saved evals
                </Label>
                <div className="flex items-center gap-1.5">
                  <Select
                    value={evalConfigs[draft.configId] ? draft.configId : ''}
                    onValueChange={(id) => {
                      const cfg = evalConfigs[id];
                      if (cfg) loadConfig(cfg);
                    }}
                  >
                    <SelectTrigger id="eval-saved" className="flex-1">
                      <SelectValue placeholder="Load a saved eval…" />
                    </SelectTrigger>
                    <SelectContent>
                      {savedConfigs.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="New eval"
                    title="Start a new eval"
                    onClick={newDraft}
                  >
                    <FilePlus2 className="h-3.5 w-3.5" />
                  </Button>
                  {evalConfigs[draft.configId] && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Delete saved eval"
                      title="Delete saved eval"
                      onClick={() => void deleteConfig()}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  )}
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="eval-name" className="sp-label">
                Eval name
              </Label>
              <Input
                id="eval-name"
                value={draft.name}
                onChange={(e) => patchDraft({ name: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="eval-system" className="sp-label">
                System
              </Label>
              <Textarea
                id="eval-system"
                value={draft.system}
                onChange={(e) => patchDraft({ system: e.target.value })}
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="eval-user" className="sp-label">
                User prompt ({'{{var}}'} from dataset)
              </Label>
              <Textarea
                id="eval-user"
                value={draft.user}
                onChange={(e) => patchDraft({ user: e.target.value })}
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="eval-dataset" className="sp-label">
                Dataset
              </Label>
              <Select value={draft.datasetId} onValueChange={(v) => patchDraft({ datasetId: v })}>
                <SelectTrigger id="eval-dataset">
                  <SelectValue placeholder="Select a dataset" />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(datasets).map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name} ({d.cases.length})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <span className="sp-label">Models</span>
              <ModelChecklist
                models={checklistEntries}
                selected={selected}
                onToggle={toggle}
                onChangeSelected={setSelected}
                emptyText="Add providers + discover models first."
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <span className="sp-label">Concurrency</span>
                <Stepper
                  value={draft.concurrency}
                  onChange={(v) => patchDraft({ concurrency: v })}
                  min={1}
                  max={16}
                  ariaLabel="Concurrency"
                />
              </div>
              <p className="text-sp-11 text-sp-text-dim">
                Parallel model calls — lower it if your provider rate-limits.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="eval-score-target" className="sp-label">
                Score target
              </Label>
              <Select
                value={draft.targetMode}
                onValueChange={(v) => patchDraft({ targetMode: v as EvalTargetMode })}
              >
                <SelectTrigger id="eval-score-target">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">Model output (text)</SelectItem>
                  <SelectItem value="http">Execute as HTTP request</SelectItem>
                  <SelectItem value="graphql">Execute as GraphQL request</SelectItem>
                </SelectContent>
              </Select>
              {draft.targetMode !== 'text' && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sp-11 text-amber-800 dark:text-amber-100"
                >
                  <AlertTriangle
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500"
                    aria-hidden
                  />
                  <p>
                    Each cell sends the model-authored request to the live endpoint (through the
                    same SSRF guard as normal requests) and scores the real upstream response. Only
                    run against endpoints you trust.
                  </p>
                </div>
              )}
            </div>

            <div className="space-y-2 border-t border-sp-line pt-4">
              {running ? (
                <Button variant="destructive" size="cta" onClick={stop} className="w-full">
                  <Square className="h-3.5 w-3.5" /> Stop
                </Button>
              ) : (
                <Button
                  variant="cta"
                  size="cta"
                  onClick={run}
                  disabled={!canRun}
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
                      onClick={() => openReport(lastRunId)}
                    >
                      View report
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Scorers + live results — fills the window. */}
        <div className="flex flex-1 flex-col overflow-auto p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="sp-label">Scorers</span>
            <Select
              value=""
              onValueChange={(k) =>
                setScorers([...scorers, defaultScorer(k as ScorerKind, firstModelRef)])
              }
            >
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Add scorer" />
              </SelectTrigger>
              <SelectContent>
                {SCORER_KINDS.map((s) => (
                  <SelectItem key={s.kind} value={s.kind}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            {scorers.map((s) => (
              <ScorerRow
                key={s.id}
                scorer={s}
                modelOptions={modelOptions}
                onChange={(patch) => updateScorer(s.id, patch)}
                onRemove={() => setScorers(scorers.filter((x) => x.id !== s.id))}
              />
            ))}
            {scorers.length === 0 && (
              <Floater
                radius="panel"
                elevation="inset"
                className="px-3 py-4 text-center text-sp-12 text-sp-muted"
              >
                No scorers yet — cells will record output only. Add one above.
              </Floater>
            )}
          </div>

          {progress && progress.cells.length > 0 && (
            <div className="mt-4 space-y-2 border-t border-sp-line pt-4">
              <span className="sp-label">Live results</span>
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
                {progress.cells.map((cell) => {
                  const modelKeyStr = `${cell.modelRef.providerConfigId}:${cell.modelRef.model}`;
                  const label = labelByModel[modelKeyStr] ?? cell.modelRef.model;
                  return (
                    <Floater
                      key={`${cell.caseId}:${modelKeyStr}`}
                      radius="panel"
                      elevation="inset"
                      className="flex flex-col gap-2 p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sp-12 font-medium text-sp-text">
                          {label}
                        </span>
                        <VerdictChip passed={cell.passed} notEvaluated={cell.notEvaluated} />
                      </div>
                      <div className="text-sp-11 text-sp-muted tabular-nums">
                        {Math.round(cell.latencyMs)}ms
                      </div>
                      <div className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-sp-bg p-2 text-sp-11 text-sp-text">
                        {cell.error ? (
                          <span className="text-destructive">{cell.error}</span>
                        ) : (
                          cell.output || <span className="text-sp-muted">(empty)</span>
                        )}
                      </div>
                    </Floater>
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

function ScorerRow({
  scorer,
  modelOptions,
  onChange,
  onRemove,
}: {
  scorer: ScorerConfig;
  modelOptions: ModelOption[];
  onChange: (patch: Partial<ScorerConfig>) => void;
  onRemove: () => void;
}) {
  return (
    <Floater radius="panel" elevation="inset" className="space-y-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sp-12 font-semibold text-sp-text">{SCORER_LABEL[scorer.kind]}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Remove scorer"
          title="Remove scorer"
          onClick={onRemove}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {scorer.kind === 'contains' && (
        <Input
          placeholder="text to find"
          value={scorer.needle}
          onChange={(e) => onChange({ needle: e.target.value })}
        />
      )}
      {scorer.kind === 'regex' && (
        <Input
          placeholder="pattern"
          value={scorer.pattern}
          onChange={(e) => onChange({ pattern: e.target.value })}
        />
      )}
      {scorer.kind === 'exact-match' && (
        <Select
          value={scorer.expectedFrom}
          onValueChange={(v) => onChange({ expectedFrom: v as 'expected' | 'reference' })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="expected">vs case.expected</SelectItem>
            <SelectItem value="reference">vs case.reference</SelectItem>
          </SelectContent>
        </Select>
      )}
      {scorer.kind === 'json-schema' && (
        <Textarea
          className="font-mono text-sp-13"
          rows={3}
          value={scorer.schema}
          onChange={(e) => onChange({ schema: e.target.value })}
        />
      )}
      {scorer.kind === 'latency' && (
        <Input
          className="w-32"
          type="number"
          value={scorer.maxMs}
          onChange={(e) => onChange({ maxMs: Number(e.target.value) || 0 })}
        />
      )}
      {scorer.kind === 'cost' && (
        <Input
          className="w-32"
          type="number"
          step={0.001}
          min={0}
          value={scorer.maxUSD}
          onChange={(e) => onChange({ maxUSD: Number(e.target.value) || 0 })}
        />
      )}
      {scorer.kind === 'script' && (
        <Textarea
          className="font-mono text-sp-13"
          rows={3}
          placeholder="pm.test('...', () => pm.expect(pm.response.text()).to.include('...'))"
          value={scorer.code}
          onChange={(e) => onChange({ code: e.target.value })}
        />
      )}
      {scorer.kind === 'judge' && (
        <JudgeScorerEditor scorer={scorer} modelOptions={modelOptions} onChange={onChange} />
      )}
      {scorer.kind === 'tool-call' && (
        <div className="space-y-2">
          <Input
            placeholder="expected tool name (blank = any tool call)"
            value={scorer.expectedTool ?? ''}
            onChange={(e) => onChange({ expectedTool: e.target.value })}
          />
          <Textarea
            className="font-mono text-sp-13"
            rows={3}
            placeholder='args JSON schema (optional), e.g. {"type":"object","required":["url"]}'
            value={scorer.argsSchema ?? ''}
            onChange={(e) => onChange({ argsSchema: e.target.value })}
          />
        </div>
      )}
      {scorer.kind === 'pairwise' && (
        <div className="space-y-2">
          <Label htmlFor={`pairwise-judge-model-${scorer.id}`} className="sp-label">
            Judge model
          </Label>
          <JudgeModelSelect
            id={`pairwise-judge-model-${scorer.id}`}
            value={scorer.judgeModel}
            modelOptions={modelOptions}
            onChange={(judgeModel) => onChange({ judgeModel })}
          />
          <label
            htmlFor="eval-scorer-swap-positions"
            className="flex items-center gap-2 text-sp-12 text-sp-text"
          >
            <Checkbox
              id="eval-scorer-swap-positions"
              checked={scorer.swapPositions ?? false}
              onCheckedChange={(v) => onChange({ swapPositions: v === true })}
            />
            Swap positions (cancel bias)
          </label>
          <p className="text-sp-11 text-sp-text-dim">
            Compares the output against each case&apos;s reference.
          </p>
        </div>
      )}
    </Floater>
  );
}

/** Judge-model picker shared by the judge and pairwise scorer editors. */
function JudgeModelSelect({
  id,
  value,
  modelOptions,
  onChange,
}: {
  id?: string;
  value: ModelRef;
  modelOptions: ModelOption[];
  onChange: (judgeModel: ModelRef) => void;
}) {
  return (
    <Select value={modelKey(value)} onValueChange={(v) => onChange(parseModelKey(v))}>
      <SelectTrigger id={id}>
        <SelectValue placeholder="Judge model" />
      </SelectTrigger>
      <SelectContent>
        {modelOptions.map((m) => (
          <SelectItem key={m.key} value={m.key}>
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Judge scorer editor: a judge model, a list of weighted criteria (each scored
 * independently; `gate` criteria fail the cell regardless of the weighted
 * score), a pass bar, and a self-consistency sample count. The whole judging
 * algorithm runs in the shared runJudge engine.
 */
function JudgeScorerEditor({
  scorer,
  modelOptions,
  onChange,
}: {
  scorer: Extract<ScorerConfig, { kind: 'judge' }>;
  modelOptions: ModelOption[];
  onChange: (patch: Partial<ScorerConfig>) => void;
}) {
  const criteria = scorer.criteria ?? [];
  const samples = scorer.samples ?? 1;
  const setCriterion = (i: number, patch: Partial<(typeof criteria)[number]>) =>
    onChange({ criteria: criteria.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) });
  const addCriterion = () =>
    onChange({
      criteria: [...criteria, { name: `criterion ${criteria.length + 1}`, rubric: '', weight: 1 }],
    });
  const removeCriterion = (i: number) =>
    onChange({ criteria: criteria.filter((_, idx) => idx !== i) });

  return (
    <div className="space-y-3">
      <JudgeModelSelect
        value={scorer.judgeModel}
        modelOptions={modelOptions}
        onChange={(judgeModel) => onChange({ judgeModel })}
      />

      <div className="space-y-2.5">
        {criteria.map((c, i) => (
          <div key={i} className="space-y-1.5 border-l-2 border-sp-line pl-3">
            <div className="flex items-center gap-2">
              <Input
                className="flex-1"
                placeholder="criterion name"
                value={c.name}
                onChange={(e) => setCriterion(i, { name: e.target.value })}
              />
              <Input
                className="w-16"
                type="number"
                step={0.5}
                min={0}
                title="weight in the aggregate score"
                value={c.weight ?? 1}
                onChange={(e) => setCriterion(i, { weight: Number(e.target.value) || 1 })}
              />
              <label
                htmlFor={`eval-criterion-gate-${i}`}
                className="flex shrink-0 items-center gap-1.5 text-sp-12 text-sp-muted"
                title="A failing gate criterion fails the cell regardless of the weighted score"
              >
                <Checkbox
                  id={`eval-criterion-gate-${i}`}
                  checked={!!c.gate}
                  onCheckedChange={(v) => setCriterion(i, { gate: v === true })}
                />
                gate
              </label>
              {criteria.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove criterion"
                  title="Remove criterion"
                  onClick={() => removeCriterion(i)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            <Textarea
              rows={2}
              placeholder="rubric for this criterion"
              value={c.rubric}
              onChange={(e) => setCriterion(i, { rubric: e.target.value })}
            />
          </div>
        ))}
      </div>
      <Button variant="ghost" size="sm" onClick={addCriterion}>
        <Plus className="h-3.5 w-3.5" /> Add criterion
      </Button>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label
          htmlFor="eval-judge-pass-threshold"
          className="flex items-center gap-2 text-sp-12 text-sp-muted"
          title="Per-criterion score bar (0–1)"
        >
          pass ≥
          <Input
            id="eval-judge-pass-threshold"
            className="w-16"
            type="number"
            step={0.05}
            min={0}
            max={1}
            value={scorer.passThreshold}
            onChange={(e) => onChange({ passThreshold: Number(e.target.value) || 0 })}
          />
        </label>
        <label
          htmlFor="eval-judge-samples"
          className="flex items-center gap-2 text-sp-12 text-sp-muted"
          title="Self-consistency: run the judge N times, take the median, report variance"
        >
          samples
          <Input
            id="eval-judge-samples"
            className="w-16"
            type="number"
            min={1}
            max={5}
            value={samples}
            onChange={(e) =>
              onChange({ samples: Math.max(1, Math.min(5, Number(e.target.value) || 1)) })
            }
          />
        </label>
      </div>
      {samples > 1 && (
        <p className="text-sp-11 text-sp-muted">
          ×{samples} judge calls per cell (self-consistency).
        </p>
      )}
    </div>
  );
}
