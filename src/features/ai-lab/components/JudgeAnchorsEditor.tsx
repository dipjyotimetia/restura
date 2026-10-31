import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { JudgeAnchor } from '../types';

interface JudgeAnchorsEditorProps {
  anchors: JudgeAnchor[] | undefined;
  /** `undefined` when the last anchor is removed, so the scorer config stays clean. */
  onChange: (anchors: JudgeAnchor[] | undefined) => void;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Calibration examples that pin the judge's 0-1 scale (sent with every judge call). */
export function JudgeAnchorsEditor({ anchors, onChange }: JudgeAnchorsEditorProps) {
  const list = anchors ?? [];
  const update = (index: number, patch: Partial<JudgeAnchor>) =>
    onChange(list.map((anchor, current) => (current === index ? { ...anchor, ...patch } : anchor)));

  return (
    <div className="space-y-2" data-testid="judge-anchors-editor">
      <span className="sp-label">Calibration anchors</span>
      {list.map((anchor, index) => (
        <div key={index} className="space-y-1.5 border-l-2 border-sp-line pl-3">
          <div className="flex items-center gap-2">
            <Input
              className="w-20"
              type="number"
              step={0.1}
              min={0}
              max={1}
              aria-label={`Anchor ${index + 1} score`}
              title="Score this example deserves (0-1)"
              value={anchor.score}
              onChange={(event) =>
                update(index, { score: clamp01(Number(event.target.value) || 0) })
              }
            />
            <Input
              className="flex-1"
              placeholder="why this score (optional)"
              value={anchor.note ?? ''}
              onChange={(event) => {
                const { note: _drop, ...rest } = anchor;
                onChange(
                  list.map((current, i) =>
                    i === index
                      ? event.target.value
                        ? { ...rest, note: event.target.value }
                        : rest
                      : current
                  )
                );
              }}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove anchor ${index + 1}`}
              title="Remove anchor"
              onClick={() => {
                const next = list.filter((_, current) => current !== index);
                onChange(next.length > 0 ? next : undefined);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <Textarea
            rows={2}
            placeholder="example output"
            value={anchor.output}
            onChange={(event) => update(index, { output: event.target.value })}
          />
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onChange([...list, { output: '', score: 0.5 }])}
      >
        <Plus className="h-3.5 w-3.5" /> Add anchor
      </Button>
    </div>
  );
}
