import { FlaskConical, FileText, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  dispatchInlineAiAction,
  useAiActionsAvailable,
  INLINE_ACTION_LABELS,
  type InlineAiAction,
} from '@/features/ai/lib/inlineActions';

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
 * A small, self-gating inline AI action button. Renders nothing when AI actions
 * are unavailable (non-Electron build, or no configured provider), so callers
 * can drop it into a toolbar without their own guard.
 */
export function AiActionButton({ action, showLabel = false, className }: Props) {
  const available = useAiActionsAvailable();
  if (!available) return null;
  const Icon = ICONS[action];
  const label = INLINE_ACTION_LABELS[action];
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => dispatchInlineAiAction(action)}
      title={`${label} — opens the AI assistant and proposes an action you approve`}
      aria-label={label}
      className={className}
    >
      <Icon className="h-3.5 w-3.5 text-sp-accent" />
      {showLabel && <span className="ml-1 text-xs">{label}</span>}
    </Button>
  );
}

export default AiActionButton;
