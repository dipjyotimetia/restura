import { ChevronUp, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/shared/utils';

export interface StepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  className?: string;
  ariaLabel?: string;
}

export function Stepper({
  value,
  onChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  unit,
  className,
  ariaLabel,
}: StepperProps) {
  const inc = () => onChange(Math.min(max, value + step));
  const dec = () => onChange(Math.max(min, value - step));
  return (
    <div
      className={cn(
        'inline-flex items-center h-7 rounded-sp-btn bg-sp-surface-lo border border-sp-line',
        className
      )}
      aria-label={ariaLabel}
    >
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isNaN(v)) onChange(Math.min(max, Math.max(min, v)));
        }}
        className="w-16 h-full bg-transparent text-sp-text font-mono text-sp-12 text-right px-2 outline-none tabular-nums"
      />
      {unit && <span className="text-sp-dim text-sp-11 font-mono pr-2">{unit}</span>}
      <div className="flex flex-col h-full border-l border-sp-line">
        <button
          type="button"
          onClick={inc}
          className="flex-1 px-1.5 hover:bg-sp-hover text-sp-muted hover:text-sp-text"
          aria-label="Increase"
        >
          <ChevronUp size={10} />
        </button>
        <button
          type="button"
          onClick={dec}
          className="flex-1 px-1.5 hover:bg-sp-hover text-sp-muted hover:text-sp-text border-t border-sp-line"
          aria-label="Decrease"
        >
          <ChevronDown size={10} />
        </button>
      </div>
    </div>
  );
}
