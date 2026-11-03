import { Copy } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** Settings primitives are passed in so this feature does not import the settings feature. */
export interface SettingsPrimitives {
  Group: (props: { label: string; children: ReactNode }) => ReactNode;
  Row: (props: { label: string; hint?: ReactNode; control: ReactNode }) => ReactNode;
}

export function CopyBlock({
  label,
  text,
  testId,
}: {
  label: string;
  text: string;
  testId?: string;
}) {
  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sp-12 font-semibold text-sp-text">{label}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(text);
            toast.success(`${label} copied`);
          }}
        >
          <Copy /> Copy
        </Button>
      </div>
      <pre
        data-testid={testId}
        className="mt-2 overflow-x-auto rounded-md bg-sp-surface-lo p-2 font-mono text-sp-11 text-sp-text whitespace-pre"
      >
        {text}
      </pre>
    </div>
  );
}

export function LevelSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger className="h-7 w-[132px] text-xs" aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
