import { cn } from '@/lib/shared/utils';

export interface ToggleFieldProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  size?: 'sm' | 'md';
  className?: string;
}

export function ToggleField({
  checked,
  onChange,
  disabled,
  ariaLabel,
  size = 'md',
  className,
}: ToggleFieldProps) {
  const dims =
    size === 'sm' ? { w: 24, h: 14, knob: 10, gap: 2 } : { w: 36, h: 22, knob: 18, gap: 2 };
  const offset = checked ? dims.w - dims.knob - dims.gap : dims.gap;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 items-center transition-all',
        'rounded-full focus-visible:outline-none',
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
      style={{
        width: dims.w,
        height: dims.h,
        background: checked ? 'var(--sp-accent)' : 'var(--sp-line-strong)',
      }}
    >
      <span
        aria-hidden="true"
        // Hairline keeps the white knob legible on the light-mode OFF track
        // (sp-line-strong is near-white there); invisible on the accent/dark
        // tracks where white already contrasts.
        className="absolute rounded-full bg-white border border-black/10 shadow-sm transition-transform"
        style={{
          width: dims.knob,
          height: dims.knob,
          top: (dims.h - dims.knob) / 2,
          left: offset,
        }}
      />
    </button>
  );
}
