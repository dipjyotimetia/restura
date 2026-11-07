import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Sparkles } from 'lucide-react';
import {
  CONFIGURE_AI_HINT,
  dispatchInlineAiAction,
  INLINE_ACTION_LABELS,
  INLINE_ACTIONS,
  useAiActionsState,
} from '@/features/ai/lib/inlineActions';
import { openAiSettings } from '@/features/ai/lib/providerReadiness';
import { cn } from '@/lib/shared/utils';

interface Props {
  className?: string;
}

/**
 * A self-gating "AI actions" dropdown (Fix request / Generate tests / Enrich
 * docs). Renders nothing when AI actions are unavailable, so callers can drop it
 * into a toolbar without their own guard. Lives in the AI feature so the http
 * feature (which has a stricter tsconfig) never imports the AI store.
 */
export function AiActionsMenu({ className }: Props) {
  const state = useAiActionsState();
  if (state === 'hidden') return null;
  const unconfigured = state === 'unconfigured';
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="AI actions"
          title={
            unconfigured
              ? `AI actions — ${CONFIGURE_AI_HINT}`
              : 'AI actions — propose a fix, tests, or docs you approve'
          }
          className={cn(
            'inline-flex items-center justify-center h-7 w-7 rounded-sp-btn text-sp-dim',
            'hover:text-sp-accent hover:bg-sp-hover transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sp-accent-glow-33)]',
            className
          )}
        >
          <Sparkles className="h-3.5 w-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className={cn(
            'z-50 w-44 rounded-sp-panel sp-floater-lg overflow-hidden p-0.5',
            'data-[state=open]:animate-sp-fade-in'
          )}
        >
          {unconfigured && (
            <DropdownMenu.Item
              onSelect={openAiSettings}
              className={cn(
                'w-full px-2.5 py-1.5 rounded-sp-btn outline-none cursor-default text-sp-11 text-sp-muted',
                'data-[highlighted]:bg-sp-hover transition-colors'
              )}
            >
              Configure an AI provider…
            </DropdownMenu.Item>
          )}
          {INLINE_ACTIONS.map((action) => (
            <DropdownMenu.Item
              key={action}
              disabled={unconfigured}
              onSelect={() => dispatchInlineAiAction(action)}
              className={cn(
                'w-full px-2.5 py-1.5 rounded-sp-btn outline-none cursor-default text-sp-12',
                'data-[highlighted]:bg-sp-hover transition-colors data-[disabled]:opacity-50'
              )}
            >
              {INLINE_ACTION_LABELS[action]}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export default AiActionsMenu;
