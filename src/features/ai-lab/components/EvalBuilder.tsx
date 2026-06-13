import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Play, Plus, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Floater } from '@/components/ui/spatial';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { v4 as uuidv4 } from 'uuid';
import { useAiLabStore } from '../store/useAiLabStore';
import { useEvalRun } from '../hooks/useEvalRun';
import type { AiLabProviderConfig, EvalConfig, ModelRef, ScorerConfig, ScorerKind } from '../types';

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
];

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
    const promptId = upsertPrompt({ name: `${name} prompt`, system, user });
    const config: EvalConfig = {
      id: configId,
      name,
      promptId,
      datasetId,
      models,
      scorers,
      concurrency,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    upsertEvalConfig(config);
    start(config);
  };

  const passCount = progress?.cells.filter((c) => c.passed).length ?? 0;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Floater radius="panel" elevation="float" className="space-y-3 bg-sp-surface p-4">
        <div className="space-y-1">
          <label className="text-sp-11 text-sp-muted font-mono">Eval name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <label className="text-sp-11 text-sp-muted font-mono">System</label>
          <Textarea value={system} onChange={(e) => setSystem(e.target.value)} rows={2} />
        </div>
        <div className="space-y-1">
          <label className="text-sp-11 text-sp-muted font-mono">
            User prompt ({'{{var}}'} from dataset)
          </label>
          <Textarea value={user} onChange={(e) => setUser(e.target.value)} rows={3} />
        </div>
        <div className="space-y-1">
          <label className="text-sp-11 text-sp-muted font-mono">Dataset</label>
          <Select value={datasetId} onValueChange={setDatasetId}>
            <SelectTrigger>
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
        <div className="space-y-1">
          <label className="text-sp-11 text-sp-muted font-mono">Models</label>
          <Floater radius="btn" elevation="inset" className="max-h-40 space-y-1 overflow-auto p-2">
            {modelOptions.length === 0 && (
              <p className="text-sp-12 text-sp-muted">Add providers + discover models first.</p>
            )}
            {modelOptions.map((m) => (
              <label key={m.key} className="flex items-center gap-2 text-sp-12 text-sp-text">
                <Checkbox checked={selected.has(m.key)} onCheckedChange={() => toggle(m.key)} />
                {m.label}
              </label>
            ))}
          </Floater>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sp-11 text-sp-muted font-mono">Concurrency</label>
          <Input
            type="number"
            min={1}
            max={16}
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value) || 1)}
            className="w-20"
          />
        </div>
      </Floater>

      <Floater radius="panel" elevation="float" className="space-y-3 bg-sp-surface p-4">
        <div className="flex items-center justify-between">
          <label className="text-sp-11 text-sp-muted font-mono">Scorers</label>
          <Select
            value=""
            onValueChange={(k) =>
              setScorers((p) => [...p, defaultScorer(k as ScorerKind, firstModelRef)])
            }
          >
            <SelectTrigger className="h-7 w-36 text-xs">
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
            <p className="text-sp-12 text-sp-muted">No scorers — cells will record output only.</p>
          )}
        </div>

        {running ? (
          <Button variant="destructive" size="cta" onClick={stop}>
            <Square className="h-3.5 w-3.5" /> Stop
          </Button>
        ) : (
          <Button variant="cta" size="cta" onClick={run}>
            <Play className="h-3.5 w-3.5" /> Run eval
          </Button>
        )}
        {error && <p className="text-sp-12 text-destructive">{error}</p>}
        {progress && (
          <div className="space-y-1">
            <Progress value={(progress.completed / Math.max(1, progress.total)) * 100} />
            <p className="text-sp-12 text-sp-muted">
              {progress.completed}/{progress.total} cells · {passCount} passed
              {progress.done && ' · done — see Reports'}
            </p>
          </div>
        )}
      </Floater>
    </div>
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
    <Floater radius="btn" elevation="inset" className="flex items-start gap-2 p-2">
      <div className="flex-1 space-y-1">
        <div className="text-sp-12 font-medium text-sp-text">{scorer.kind}</div>
        {scorer.kind === 'contains' && (
          <Input
            className="h-7 text-xs"
            placeholder="text to find"
            value={scorer.needle}
            onChange={(e) => onChange({ needle: e.target.value })}
          />
        )}
        {scorer.kind === 'regex' && (
          <Input
            className="h-7 text-xs"
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
            <SelectTrigger className="h-7 text-xs">
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
            className="font-mono text-xs"
            rows={3}
            value={scorer.schema}
            onChange={(e) => onChange({ schema: e.target.value })}
          />
        )}
        {scorer.kind === 'latency' && (
          <Input
            className="h-7 w-24 text-xs"
            type="number"
            value={scorer.maxMs}
            onChange={(e) => onChange({ maxMs: Number(e.target.value) || 0 })}
          />
        )}
        {scorer.kind === 'cost' && (
          <Input
            className="h-7 w-28 text-xs"
            type="number"
            step={0.001}
            min={0}
            value={scorer.maxUSD}
            onChange={(e) => onChange({ maxUSD: Number(e.target.value) || 0 })}
          />
        )}
        {scorer.kind === 'script' && (
          <Textarea
            className="font-mono text-xs"
            rows={3}
            placeholder="pm.test('...', () => pm.expect(pm.response.text()).to.include('...'))"
            value={scorer.code}
            onChange={(e) => onChange({ code: e.target.value })}
          />
        )}
        {scorer.kind === 'judge' && (
          <JudgeScorerEditor scorer={scorer} modelOptions={modelOptions} onChange={onChange} />
        )}
      </div>
      <Button variant="ghost" size="sm" onClick={onRemove} className="h-6 w-6 p-0">
        <X className="h-3 w-3" />
      </Button>
    </Floater>
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
    <div className="space-y-1.5">
      <Select
        value={`${scorer.judgeModel.providerConfigId}:${scorer.judgeModel.model}`}
        onValueChange={(v) => {
          // Split on the FIRST colon only: the provider id is a UUID (no colons)
          // but model ids can contain them (Ollama `llama3.2:latest`).
          const i = v.indexOf(':');
          onChange({ judgeModel: { providerConfigId: v.slice(0, i), model: v.slice(i + 1) } });
        }}
      >
        <SelectTrigger className="h-7 text-xs">
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

      {criteria.map((c, i) => (
        <Floater key={i} radius="btn" elevation="inset" className="space-y-1 p-1.5">
          <div className="flex items-center gap-1">
            <Input
              className="h-6 flex-1 text-xs"
              placeholder="criterion name"
              value={c.name}
              onChange={(e) => setCriterion(i, { name: e.target.value })}
            />
            <Input
              className="h-6 w-14 text-xs"
              type="number"
              step={0.5}
              min={0}
              title="weight in the aggregate score"
              value={c.weight ?? 1}
              onChange={(e) => setCriterion(i, { weight: Number(e.target.value) || 1 })}
            />
            <label
              className="flex items-center gap-1 text-sp-11 text-sp-muted"
              title="A failing gate criterion fails the cell regardless of the weighted score"
            >
              <Checkbox
                checked={!!c.gate}
                onCheckedChange={(v) => setCriterion(i, { gate: v === true })}
              />
              gate
            </label>
            {criteria.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                onClick={() => removeCriterion(i)}
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
          <Textarea
            className="text-xs"
            rows={2}
            placeholder="rubric for this criterion"
            value={c.rubric}
            onChange={(e) => setCriterion(i, { rubric: e.target.value })}
          />
        </Floater>
      ))}
      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={addCriterion}>
        <Plus className="h-3 w-3" /> Add criterion
      </Button>

      <div className="flex items-center gap-2">
        <label className="text-sp-11 text-sp-muted font-mono" title="Per-criterion score bar (0–1)">
          pass ≥
        </label>
        <Input
          className="h-7 w-16 text-xs"
          type="number"
          step={0.05}
          min={0}
          max={1}
          value={scorer.passThreshold}
          onChange={(e) => onChange({ passThreshold: Number(e.target.value) || 0 })}
        />
        <label
          className="text-sp-11 text-sp-muted font-mono"
          title="Self-consistency: run the judge N times, take the median, report variance"
        >
          samples
        </label>
        <Input
          className="h-7 w-16 text-xs"
          type="number"
          min={1}
          max={5}
          value={samples}
          onChange={(e) =>
            onChange({ samples: Math.max(1, Math.min(5, Number(e.target.value) || 1)) })
          }
        />
      </div>
      {samples > 1 && (
        <p className="text-sp-11 text-sp-muted">
          ×{samples} judge calls per cell (self-consistency).
        </p>
      )}
    </div>
  );
}
