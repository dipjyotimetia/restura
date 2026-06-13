import { Checkbox } from '@/components/ui/checkbox';
import { Floater } from '@/components/ui/spatial';

/**
 * Bounded, scrollable multi-select of provider models. Shared by the Playground
 * and the eval builder, which both pick a set of models to run against.
 */
export function ModelChecklist({
  models,
  selected,
  onToggle,
  emptyText,
}: {
  models: Array<{ key: string; label: string }>;
  selected: Set<string>;
  onToggle: (key: string) => void;
  emptyText: string;
}) {
  if (models.length === 0) {
    return <p className="px-2 py-1.5 text-sp-12 text-sp-muted">{emptyText}</p>;
  }
  return (
    <Floater radius="btn" elevation="inset" className="max-h-56 space-y-0.5 overflow-auto p-1.5">
      {models.map((m) => (
        <label
          key={m.key}
          className="flex cursor-pointer items-center gap-2 rounded-sp-btn px-2 py-1.5 text-sp-12 text-sp-text hover:bg-sp-hover"
        >
          <Checkbox checked={selected.has(m.key)} onCheckedChange={() => onToggle(m.key)} />
          {m.label}
        </label>
      ))}
    </Floater>
  );
}
