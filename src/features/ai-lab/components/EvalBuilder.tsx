import { AlertTriangle, Play, Plus, Square, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';
import { useEvalRun } from '../hooks/useEvalRun';
import { useAiLabStore } from '../store/useAiLabStore';
import type {
  AiLabProviderConfig,
  EvalConfig,
  EvalTarget,
  ModelRef,
  ScorerConfig,
  ScorerKind,
} from '../types';
import { ModelChecklist } from './ModelChecklist';
import { StatusChip } from './StatusChip';
import { VerdictChip } from './VerdictChip';
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

/** UI selection for what a cell scores. */
type TargetMode = 'text' | 'http' | 'graphql';

function targetFor(mode: TargetMode): EvalTarget {
  if (mode === 'text') return { kind: 'text' };
  return { kind: 'http-exec', parseFrom: 'fenced', protocol: mode };
}

interface ModelOption {
  key: string;
  cfg: AiLabProviderConfig;
  model: string;
  label: string;
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
  const upsertPrompt = useAiLabStore((s) => s.upsertPrompt);
  const upsertEvalConfig = useAiLabStore((s) => s.upsertEvalConfig);
  const { running, progress, error, start, stop } = useEvalRun();

  const [name, setName] = useState('My eval');
  const [system, setSystem] = useState('You are concise.');
  const [user, setUser] = useState('Capital of {{country}}?');
  const [datasetId, setDatasetId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scorers, setScorers] = useState<ScorerConfig[]>([]);
  const [concurrency, setConcurrency] = useState(4);
  const [targetMode, setTargetMode] = useState<TargetMode>('text');
  // Stable id for this eval across re-runs: upsertEvalConfig overwrites instead
  // of accumulating a new config per run (which would also leak unbounded into
  // the store), and a stable evalConfigId lets ReportView's "Δ vs prev"
  // regression compare find the previous run of this eval.
  const [configId] = useState(() => uuidv4());

  const modelOptions = useMemo<ModelOption[]>(() => {
    const out: ModelOption[] = [];
    for (const cfg of Object.values(providers))
      for (const model of cfg.models)
        out.push({ key: `${cfg.id}:${model}`, cfg, model, label: `${cfg.label} · ${model}` });
    return out;
  }, [providers]);

  const firstModelRef = modelOptions[0]
    ? { providerConfigId: modelOptions[0].cfg.id, model: modelOptions[0].model }
    : undefined;

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const updateScorer = (id: string, patch: Partial<ScorerConfig>) =>
    setScorers((prev) => prev.map((s) => (s.id === id ? ({ ...s, ...patch } as ScorerConfig) : s)));

  // judge/pairwise scorers carry their own judge model — an unset one
  // (providerConfigId/model both empty, the defaultScorer() fallback) would
  // otherwise only surface as a per-cell judge-call error mid-run.
  const unconfiguredJudgeScorer = scorers.find(
    (s) =>
      (s.kind === 'judge' || s.kind === 'pairwise') &&
      (!s.judgeModel.providerConfigId || !s.judgeModel.model)
  );

  const run = () => {
    if (!datasetId) {
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
    const promptId = upsertPrompt({ name: `${name} prompt`, system, user });
    const config: EvalConfig = {
      id: configId,
      name,
      promptId,
      datasetId,
      models,
      scorers,
      concurrency,
      target: targetFor(targetMode),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    upsertEvalConfig(config);
    start(config);
  };

  const passCount = progress?.cells.filter((c) => c.passed).length ?? 0;

  const canRun = !!datasetId && selected.size > 0 && !unconfiguredJudgeScorer;
  const runDisabledReason = !datasetId
    ? 'Pick a dataset to run.'
    : selected.size === 0
      ? 'Select at least one model.'
      : unconfiguredJudgeScorer
        ? `Pick a judge model for the ${SCORER_LABEL[unconfiguredJudgeScorer.kind]} scorer.`
        : null;

  // Ordered model label lookup for the live results grid.
  const labelByModel = useMemo(
    () => Object.fromEntries(modelOptions.map((m) => [`${m.cfg.id}:${m.model}`, m.label])),
    [modelOptions]
  );

  return (
    <ResizableLayout defaultSplit={34} minSplit={24} maxSplit={55}>
      {/* Config pane — readable measure; scrolls independently. */}
      <div className="flex-1 overflow-auto p-4">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="eval-name" className="sp-label">
              Eval name
            </Label>
            <Input id="eval-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="eval-system" className="sp-label">
              System
            </Label>
            <Textarea
              id="eval-system"
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              rows={2}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="eval-user" className="sp-label">
              User prompt ({'{{var}}'} from dataset)
            </Label>
            <Textarea
              id="eval-user"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="eval-dataset" className="sp-label">
              Dataset
            </Label>
            <Select value={datasetId} onValueChange={setDatasetId}>
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
              models={modelOptions}
              selected={selected}
              onToggle={toggle}
              emptyText="Add providers + discover models first."
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="sp-label">Concurrency</span>
            <Stepper
              value={concurrency}
              onChange={setConcurrency}
              min={1}
              max={16}
              ariaLabel="Concurrency"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="eval-score-target" className="sp-label">
              Score target
            </Label>
            <Select value={targetMode} onValueChange={(v) => setTargetMode(v as TargetMode)}>
              <SelectTrigger id="eval-score-target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text">Model output (text)</SelectItem>
                <SelectItem value="http">Execute as HTTP request</SelectItem>
                <SelectItem value="graphql">Execute as GraphQL request</SelectItem>
              </SelectContent>
            </Select>
            {targetMode !== 'text' && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sp-11 text-amber-800 dark:text-amber-100"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
                <p>
                  Each cell sends the model-authored request to the live endpoint (through the same
                  SSRF guard as normal requests) and scores the real upstream response. Only run
                  against endpoints you trust.
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
              <Button variant="cta" size="cta" onClick={run} disabled={!canRun} className="w-full">
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
                {progress.done && <p className="text-sp-11 text-sp-muted">Done — see Reports.</p>}
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
              setScorers((p) => [...p, defaultScorer(k as ScorerKind, firstModelRef)])
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
              onRemove={() => setScorers((prev) => prev.filter((x) => x.id !== s.id))}
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
                      <span className="truncate text-sp-12 font-medium text-sp-text">{label}</span>
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
          <Select
            value={modelKey(scorer.judgeModel)}
            onValueChange={(v) => onChange({ judgeModel: parseModelKey(v) })}
          >
            <SelectTrigger id={`pairwise-judge-model-${scorer.id}`}>
              <SelectValue placeholder="pick a judge model" />
            </SelectTrigger>
            <SelectContent>
              {modelOptions.map((m) => (
                <SelectItem key={m.key} value={m.key}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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

/** `providerConfigId:model` round-trip for the model select. */
function modelKey(m: ModelRef): string {
  return `${m.providerConfigId}:${m.model}`;
}
function parseModelKey(key: string): ModelRef {
  const idx = key.indexOf(':');
  return { providerConfigId: key.slice(0, idx), model: key.slice(idx + 1) };
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
      <Select
        value={`${scorer.judgeModel.providerConfigId}:${scorer.judgeModel.model}`}
        onValueChange={(v) => {
          // Split on the FIRST colon only: the provider id is a UUID (no colons)
          // but model ids can contain them (Ollama `llama3.2:latest`).
          const i = v.indexOf(':');
          onChange({ judgeModel: { providerConfigId: v.slice(0, i), model: v.slice(i + 1) } });
        }}
      >
        <SelectTrigger>
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
