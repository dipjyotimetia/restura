import { FileText, FlaskConical, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  CONFIGURE_AI_HINT,
  dispatchInlineAiAction,
  INLINE_ACTION_LABELS,
  type InlineAiAction,
  useAiActionsState,
} from '@/features/ai/lib/inlineActions';
import { openAiSettings } from '@/features/ai/lib/providerReadiness';
import { cn } from '@/lib/shared/utils';

const ICONS: Record<InlineAiAction, typeof Wrench> = {
  fix: Wrench,
  'generate-tests': FlaskConical,
  'enrich-docs': FileText,
};

interface Props {
  action: InlineAiAction;
  /** Show the text label next to the icon. Off → icon-only (toolbar use). */
  showLabel?: boolean;
  className?: string;
}

/**
 * A small, self-gating inline AI action button. Renders nothing off-desktop;
 * on desktop without a usable provider it renders disabled (aria-disabled, so
 * the configure hint stays reachable) and a click opens Settings → AI.
 */
export function AiActionButton({ action, showLabel = false, className }: Props) {
  const state = useAiActionsState();
  if (state === 'hidden') return null;
  const Icon = ICONS[action];
  const label = INLINE_ACTION_LABELS[action];
  const unconfigured = state === 'unconfigured';
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => (unconfigured ? openAiSettings() : dispatchInlineAiAction(action))}
      title={
        unconfigured
          ? `${label} — ${CONFIGURE_AI_HINT}`
          : `${label} — opens the AI assistant and proposes an action you approve`
      }
      aria-label={label}
      aria-disabled={unconfigured ? true : undefined}
      className={cn(unconfigured && 'opacity-50', className)}
    >
      <Icon className="h-3.5 w-3.5 text-sp-accent" />
      {showLabel && <span className="ml-1 text-xs">{label}</span>}
    </Button>
  );
}

export default AiActionButton;
