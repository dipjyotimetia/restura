import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Sparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { completeLlm, specFor } from '../lib/llmClient';
import {
  summarizeOpenApi,
  buildGenMessages,
  parseGeneratedCases,
  DATASET_TOOL,
} from '../lib/openapiTestGen';
import { useAiLabStore } from '../store/useAiLabStore';

/** Generate an eval dataset from an OpenAPI spec via a model (structured output). */
export function OpenApiGenDialog({ onCreated }: { onCreated?: (datasetId: string) => void }) {
  const providers = useAiLabStore((s) => s.providers);
  const upsertDataset = useAiLabStore((s) => s.upsertDataset);

  const [open, setOpen] = useState(false);
  const [specText, setSpecText] = useState('');
  const [count, setCount] = useState(8);
  const [instructions, setInstructions] = useState('');
  const [modelKey, setModelKey] = useState('');
  const [busy, setBusy] = useState(false);

  const modelOptions = useMemo(() => {
    const out: Array<{ key: string; cfgId: string; model: string; label: string }> = [];
    for (const cfg of Object.values(providers))
      for (const model of cfg.models)
        out.push({
          key: `${cfg.id}:${model}`,
          cfgId: cfg.id,
          model,
          label: `${cfg.label} · ${model}`,
        });
    return out;
  }, [providers]);

  const generate = async () => {
    let spec: unknown;
    try {
      spec = JSON.parse(specText);
    } catch {
      toast.error('Spec must be valid JSON (YAML not supported here).');
      return;
    }
    const chosen = modelOptions.find((m) => m.key === modelKey);
    if (!chosen) {
      toast.error('Pick a model to generate with.');
      return;
    }
    const cfg = providers[chosen.cfgId];
    if (!cfg) return;

    setBusy(true);
    try {
      const summary = summarizeOpenApi(spec);
      const messages = buildGenMessages({
        summary,
        count,
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      });
      const completion = await completeLlm(
        specFor(cfg, chosen.model, messages, { tools: [DATASET_TOOL], maxOutputTokens: 4096 })
      );
      if (!completion.ok) {
        toast.error(`Generation failed: ${completion.error?.message ?? 'unknown error'}`);
        return;
      }
      const cases = parseGeneratedCases(completion).map((c, i) => ({
        id: `${Date.now()}-${i}`,
        ...c,
      }));
      if (cases.length === 0) {
        toast.error('Model returned no usable cases.');
        return;
      }
      const id = upsertDataset({ name: `${summary.title} (generated)`, cases });
      toast.success(`Generated ${cases.length} cases`);
      setOpen(false);
      onCreated?.(id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="w-full">
          <Sparkles className="mr-2 h-3.5 w-3.5" /> From OpenAPI
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader icon={Sparkles}>
          <DialogTitle>Generate dataset from OpenAPI</DialogTitle>
          <DialogDescription>
            Paste an OpenAPI/Swagger JSON spec. A model will generate test cases as a new dataset.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Textarea
            value={specText}
            onChange={(e) => setSpecText(e.target.value)}
            rows={10}
            className="font-mono text-sp-13"
            placeholder='{ "openapi": "3.0.0", "info": {...}, "paths": {...} }'
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="sp-label">Generate with</Label>
              <Select value={modelKey} onValueChange={setModelKey}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((m) => (
                    <SelectItem key={m.key} value={m.key}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="sp-label"># cases</Label>
              <Input
                type="number"
                min={1}
                max={50}
                value={count}
                onChange={(e) => setCount(Number(e.target.value) || 1)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="sp-label">Extra instructions (optional)</Label>
            <Input
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. focus on error cases"
            />
          </div>
        </div>
        <DialogFooter>
          <Button size="sm" onClick={() => void generate()} disabled={busy || !specText.trim()}>
            {busy ? 'Generating…' : 'Generate dataset'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
