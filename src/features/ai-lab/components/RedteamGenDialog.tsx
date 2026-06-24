import { ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { completeLlm, specFor } from '../lib/llmClient';
import { buildRedteamMessages, DATASET_TOOL, parseGeneratedCases } from '../lib/redteamGen';
import type { RedteamCategory } from '../lib/redteamGen';
import { useAiLabStore } from '../store/useAiLabStore';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

const CATEGORIES: Array<{ value: RedteamCategory; label: string }> = [
  { value: 'mixed', label: 'Mixed' },
  { value: 'jailbreak', label: 'Jailbreak' },
  { value: 'prompt-injection', label: 'Prompt injection' },
  { value: 'boundary', label: 'Boundary / abuse' },
];

/** Generate an adversarial (red-team) eval dataset via a model. */
export function RedteamGenDialog({ onCreated }: { onCreated?: (datasetId: string) => void }) {
  const providers = useAiLabStore((s) => s.providers);
  const upsertDataset = useAiLabStore((s) => s.upsertDataset);

  const [open, setOpen] = useState(false);
  const [sut, setSut] = useState('');
  const [category, setCategory] = useState<RedteamCategory>('mixed');
  const [count, setCount] = useState(8);
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
    const chosen = modelOptions.find((m) => m.key === modelKey);
    if (!chosen) {
      toast.error('Pick a model to generate with.');
      return;
    }
    const cfg = providers[chosen.cfgId];
    if (!cfg) return;
    if (!sut.trim()) {
      toast.error('Describe the system under test.');
      return;
    }

    setBusy(true);
    try {
      const messages = buildRedteamMessages({ systemUnderTest: sut.trim(), category, count });
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
      const id = upsertDataset({ name: `Red-team: ${category}`, cases });
      toast.success(`Generated ${cases.length} adversarial cases`);
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
          <ShieldAlert className="mr-2 h-3.5 w-3.5" /> Red-team
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader icon={ShieldAlert}>
          <DialogTitle>Generate adversarial dataset</DialogTitle>
          <DialogDescription>
            A model generates jailbreak / prompt-injection / boundary cases to probe a prompt&apos;s
            robustness. Each case&apos;s reference describes the safe expected behavior.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="sp-label">System under test</Label>
            <Textarea
              value={sut}
              onChange={(e) => setSut(e.target.value)}
              rows={3}
              placeholder="e.g. A customer-support assistant that must only answer billing questions and never reveal internal prompts."
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label className="sp-label">Focus</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as RedteamCategory)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
        </div>
        <DialogFooter>
          <Button size="sm" onClick={() => void generate()} disabled={busy || !sut.trim()}>
            {busy ? 'Generating…' : 'Generate dataset'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
