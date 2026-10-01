import { Columns, Rows } from 'lucide-react';
import type * as React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/shared/utils';
import { useSettingsStore } from '@/store/useSettingsStore';

export function IconButton({
  icon,
  label,
  onClick,
  active,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-disabled={disabled || undefined}
          className={cn(
            'inline-flex items-center justify-center size-7 rounded-sp-btn transition-colors',
            'text-sp-muted hover:text-sp-text hover:bg-sp-hover',
            active && 'text-sp-accent bg-sp-active',
            disabled && 'opacity-50 cursor-not-allowed hover:bg-transparent hover:text-sp-muted'
          )}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function LayoutToggleButton() {
  const layoutOrientation = useSettingsStore((s) => s.settings.layoutOrientation);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  // Below 1280px the workspace is always stacked (see Home), so the toggle
  // can't take effect — say so instead of silently doing nothing. aria-disabled
  // (not disabled) keeps the tooltip reachable.
  const forcedStacked = useMediaQuery('(max-width: 1279px)');
  const vertical = layoutOrientation === 'vertical';
  if (forcedStacked) {
    return (
      <IconButton
        icon={<Rows className="h-3.5 w-3.5" />}
        label="Stacked layout: side-by-side needs a window at least 1280px wide"
        disabled
      />
    );
  }
  return (
    <IconButton
      icon={vertical ? <Columns className="h-3.5 w-3.5" /> : <Rows className="h-3.5 w-3.5" />}
      label={`Switch to ${vertical ? 'side-by-side' : 'stacked'} layout`}
      onClick={() => updateSettings({ layoutOrientation: vertical ? 'horizontal' : 'vertical' })}
    />
  );
}
