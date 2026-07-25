import { Plus, X } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Floater } from '@/components/ui/spatial';
import { Textarea } from '@/components/ui/textarea';
import { type ModelOption, modelKey, parseModelKey } from '../lib/modelOptions';
import type { ModelRef, ScorerConfig, ScorerKind } from '../types';

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

export const SCORER_LABEL: Record<ScorerKind, string> = Object.fromEntries(
  SCORER_KINDS.map((scorer) => [scorer.kind, scorer.label])
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

interface ScorerEditorProps {
  scorers: ScorerConfig[];
  modelOptions: ModelOption[];
  firstModelRef: ModelRef | undefined;
  onChange: (scorers: ScorerConfig[]) => void;
}

/** Configures scorers only; the parent owns the durable draft and run lifecycle. */
export function ScorerEditor({
  scorers,
  modelOptions,
  firstModelRef,
  onChange,
}: ScorerEditorProps) {
  const updateScorer = (id: string, patch: Partial<ScorerConfig>) =>
    onChange(
      scorers.map((scorer) =>
        scorer.id === id ? ({ ...scorer, ...patch } as ScorerConfig) : scorer
      )
    );

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="sp-label">Scorers</span>
        <Select
          value=""
          onValueChange={(kind) =>
            onChange([...scorers, defaultScorer(kind as ScorerKind, firstModelRef)])
          }
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Add scorer" />
          </SelectTrigger>
          <SelectContent>
            {SCORER_KINDS.map((scorer) => (
              <SelectItem key={scorer.kind} value={scorer.kind}>
                {scorer.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        {scorers.map((scorer) => (
          <ScorerRow
            key={scorer.id}
            scorer={scorer}
            modelOptions={modelOptions}
            onChange={(patch) => updateScorer(scorer.id, patch)}
            onRemove={() => onChange(scorers.filter((candidate) => candidate.id !== scorer.id))}
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
          onChange={(event) => onChange({ needle: event.target.value })}
        />
      )}
      {scorer.kind === 'regex' && (
        <Input
          placeholder="pattern"
          value={scorer.pattern}
          onChange={(event) => onChange({ pattern: event.target.value })}
        />
      )}
      {scorer.kind === 'exact-match' && (
        <Select
          value={scorer.expectedFrom}
          onValueChange={(expectedFrom) =>
            onChange({ expectedFrom: expectedFrom as 'expected' | 'reference' })
          }
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
          onChange={(event) => onChange({ schema: event.target.value })}
        />
      )}
      {scorer.kind === 'latency' && (
        <Input
          className="w-32"
          type="number"
          value={scorer.maxMs}
          onChange={(event) => onChange({ maxMs: Number(event.target.value) || 0 })}
        />
      )}
      {scorer.kind === 'cost' && (
        <Input
          className="w-32"
          type="number"
          step={0.001}
          min={0}
          value={scorer.maxUSD}
          onChange={(event) => onChange({ maxUSD: Number(event.target.value) || 0 })}
        />
      )}
      {scorer.kind === 'script' && (
        <Textarea
          className="font-mono text-sp-13"
          rows={3}
          placeholder="pm.test('...', () => pm.expect(pm.response.text()).to.include('...'))"
          value={scorer.code}
          onChange={(event) => onChange({ code: event.target.value })}
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
            onChange={(event) => onChange({ expectedTool: event.target.value })}
          />
          <Textarea
            className="font-mono text-sp-13"
            rows={3}
            placeholder='args JSON schema (optional), e.g. {"type":"object","required":["url"]}'
            value={scorer.argsSchema ?? ''}
            onChange={(event) => onChange({ argsSchema: event.target.value })}
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
              onCheckedChange={(value) => onChange({ swapPositions: value === true })}
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
    <Select value={modelKey(value)} onValueChange={(model) => onChange(parseModelKey(model))}>
      <SelectTrigger id={id}>
        <SelectValue placeholder="Judge model" />
      </SelectTrigger>
      <SelectContent>
        {modelOptions.map((model) => (
          <SelectItem key={model.key} value={model.key}>
            {model.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

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
  const setCriterion = (index: number, patch: Partial<(typeof criteria)[number]>) =>
    onChange({
      criteria: criteria.map((criterion, current) =>
        current === index ? { ...criterion, ...patch } : criterion
      ),
    });
  const addCriterion = () =>
    onChange({
      criteria: [...criteria, { name: `criterion ${criteria.length + 1}`, rubric: '', weight: 1 }],
    });
  const removeCriterion = (index: number) =>
    onChange({ criteria: criteria.filter((_, current) => current !== index) });

  return (
    <div className="space-y-3">
      <JudgeModelSelect
        value={scorer.judgeModel}
        modelOptions={modelOptions}
        onChange={(judgeModel) => onChange({ judgeModel })}
      />
      <div className="space-y-2.5">
        {criteria.map((criterion, index) => (
          <div key={index} className="space-y-1.5 border-l-2 border-sp-line pl-3">
            <div className="flex items-center gap-2">
              <Input
                className="flex-1"
                placeholder="criterion name"
                value={criterion.name}
                onChange={(event) => setCriterion(index, { name: event.target.value })}
              />
              <Input
                className="w-16"
                type="number"
                step={0.5}
                min={0}
                title="weight in the aggregate score"
                value={criterion.weight ?? 1}
                onChange={(event) =>
                  setCriterion(index, { weight: Number(event.target.value) || 1 })
                }
              />
              <label
                htmlFor={`eval-criterion-gate-${index}`}
                className="flex shrink-0 items-center gap-1.5 text-sp-12 text-sp-muted"
                title="A failing gate criterion fails the cell regardless of the weighted score"
              >
                <Checkbox
                  id={`eval-criterion-gate-${index}`}
                  checked={!!criterion.gate}
                  onCheckedChange={(value) => setCriterion(index, { gate: value === true })}
                />
                gate
              </label>
              {criteria.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove criterion"
                  title="Remove criterion"
                  onClick={() => removeCriterion(index)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            <Textarea
              rows={2}
              placeholder="rubric for this criterion"
              value={criterion.rubric}
              onChange={(event) => setCriterion(index, { rubric: event.target.value })}
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
            onChange={(event) => onChange({ passThreshold: Number(event.target.value) || 0 })}
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
            onChange={(event) =>
              onChange({ samples: Math.max(1, Math.min(5, Number(event.target.value) || 1)) })
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
