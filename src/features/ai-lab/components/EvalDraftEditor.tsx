import { AlertTriangle, FilePlus2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Stepper } from '@/components/ui/spatial';
import { Textarea } from '@/components/ui/textarea';
import type { EvalDraft, EvalTargetMode } from '../store/useAiLabUiStore';
import type { Dataset, EvalConfig } from '../types';
import { ModelChecklist, type ModelChecklistEntry } from './ModelChecklist';

interface EvalDraftEditorProps {
  draft: EvalDraft;
  savedConfig: EvalConfig | undefined;
  savedConfigs: EvalConfig[];
  evalConfigs: Record<string, EvalConfig>;
  datasets: Record<string, Dataset>;
  checklistEntries: ModelChecklistEntry[];
  selectedSet: Set<string>;
  onPatchDraft: (patch: Partial<EvalDraft>) => void;
  onLoadConfig: (config: EvalConfig) => void;
  onNew: () => void;
  onDelete: () => void;
  onToggleModel: (key: string) => void;
  onChangeSelectedModels: (selected: Set<string>) => void;
  onOpenModels: () => void;
}

/**
 * The durable eval-config draft form. Its state remains in useAiLabUiStore so
 * a tab switch cannot discard composition that is not yet saved as an eval.
 */
export function EvalDraftEditor({
  draft,
  savedConfig,
  savedConfigs,
  evalConfigs,
  datasets,
  checklistEntries,
  selectedSet,
  onPatchDraft,
  onLoadConfig,
  onNew,
  onDelete,
  onToggleModel,
  onChangeSelectedModels,
  onOpenModels,
}: EvalDraftEditorProps) {
  return (
    <div className="space-y-4">
      {savedConfigs.length > 0 && (
        <div className="space-y-1.5">
          <Label htmlFor="eval-saved" className="sp-label">
            Saved evals
          </Label>
          <div className="flex items-center gap-1.5">
            <Select
              value={savedConfig ? draft.configId : ''}
              onValueChange={(id) => {
                const config = evalConfigs[id];
                if (config) onLoadConfig(config);
              }}
            >
              <SelectTrigger id="eval-saved" className="flex-1">
                <SelectValue placeholder="Load a saved eval…" />
              </SelectTrigger>
              <SelectContent>
                {savedConfigs.map((config) => (
                  <SelectItem key={config.id} value={config.id}>
                    {config.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New eval"
              title="Start a new eval"
              onClick={onNew}
            >
              <FilePlus2 className="h-3.5 w-3.5" />
            </Button>
            {savedConfig && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete saved eval"
                title="Delete saved eval"
                onClick={onDelete}
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
          onChange={(event) => onPatchDraft({ name: event.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="eval-system" className="sp-label">
          System
        </Label>
        <Textarea
          id="eval-system"
          value={draft.system}
          onChange={(event) => onPatchDraft({ system: event.target.value })}
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
          onChange={(event) => onPatchDraft({ user: event.target.value })}
          rows={3}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="eval-dataset" className="sp-label">
          Dataset
        </Label>
        <Select value={draft.datasetId} onValueChange={(datasetId) => onPatchDraft({ datasetId })}>
          <SelectTrigger id="eval-dataset">
            <SelectValue placeholder="Select a dataset" />
          </SelectTrigger>
          <SelectContent>
            {Object.values(datasets).map((dataset) => (
              <SelectItem key={dataset.id} value={dataset.id}>
                {dataset.name} ({dataset.cases.length})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <span className="sp-label">Models</span>
        <ModelChecklist
          models={checklistEntries}
          selected={selectedSet}
          onToggle={onToggleModel}
          onChangeSelected={onChangeSelectedModels}
          emptyText="No models are ready for this eval."
          emptyAction={
            <Button variant="outline" size="sm" onClick={onOpenModels}>
              Open Models
            </Button>
          }
        />
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <span className="sp-label">Concurrency</span>
          <Stepper
            value={draft.concurrency}
            onChange={(concurrency) => onPatchDraft({ concurrency })}
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
          onValueChange={(targetMode) => onPatchDraft({ targetMode: targetMode as EvalTargetMode })}
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
        {draft.targetMode !== 'text' && <HttpExecutionWarning />}
      </div>
    </div>
  );
}

function HttpExecutionWarning() {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sp-11 text-amber-800 dark:text-amber-100"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
      <p>
        Each cell sends the model-authored request to the live endpoint (through the same SSRF guard
        as normal requests) and scores the real upstream response. Only run against endpoints you
        trust.
      </p>
    </div>
  );
}
