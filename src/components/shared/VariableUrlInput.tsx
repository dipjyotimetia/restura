import type React from 'react';
import { useVariableHover } from '@/components/shared/VariableHover';
import { VariableInput } from '@/components/shared/VariableInput';
import { hasVariableToken, VariableText } from '@/components/ui/spatial';
import { useVariableStatus, type VariableScope } from '@/hooks/useVariableStatus';
import { cn } from '@/lib/shared/utils';

interface VariableUrlInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'className'> {
  value: string;
  onValueChange: (value: string) => void;
  /** Which resolver the URL feeds; the overlay and suggestions match its scopes. */
  variableScope?: VariableScope;
  /** Frame (border, background, height) — on the wrapper, not the input. */
  className?: string;
  /** Font, size and padding — applied to both the input and the overlay so they align. */
  textClassName?: string;
  /** Show the raw text in an error colour and skip the overlay. */
  invalid?: boolean;
}

/**
 * A URL field with `{{variable}}` autocomplete, a resolved/unresolved highlight
 * overlay, and hover cards — the HTTP URL bar's field, shared by every protocol.
 */
export function VariableUrlInput({
  value,
  onValueChange,
  variableScope = 'request',
  className,
  textClassName,
  invalid = false,
  ...inputProps
}: VariableUrlInputProps) {
  const getStatus = useVariableStatus(variableScope);
  const hover = useVariableHover(variableScope);
  const overlay = hasVariableToken(value) && !invalid;

  return (
    <div
      className={cn('relative flex min-w-0 items-center', className)}
      onMouseMove={hover.onMouseMove}
      onMouseLeave={hover.onMouseLeave}
    >
      {hover.card}
      <VariableInput
        rawInput
        type="text"
        spellCheck={false}
        {...inputProps}
        value={value}
        onValueChange={onValueChange}
        variableScope={variableScope}
        aria-invalid={invalid || undefined}
        className={cn(
          'h-full w-full bg-transparent outline-none font-mono tabular-nums caret-sp-accent placeholder:text-sp-dim',
          textClassName,
          invalid ? 'text-rose-400' : 'text-sp-text',
          // Glyphs go transparent only when the overlay draws them instead.
          overlay && 'text-transparent'
        )}
      />
      {overlay && (
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-0 flex items-center overflow-hidden',
            textClassName
          )}
        >
          <VariableText
            text={value}
            getStatus={getStatus}
            className="whitespace-pre font-mono tabular-nums text-sp-text"
          />
        </div>
      )}
    </div>
  );
}
