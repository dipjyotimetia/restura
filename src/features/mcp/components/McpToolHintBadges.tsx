import { isDestructiveTool } from '@shared/protocol/mcp-tool-descriptor';
import { cn } from '@/lib/shared/utils';
import type { McpToolDescriptor } from '@/types';

const HINT_BADGE_CLASS =
  'inline-flex items-center px-1.5 h-4 rounded-[5px] font-mono font-bold text-sp-11';

/**
 * Behaviour hints from the server. Untrusted: they describe what the server
 * claims, so the tooltip says so and nothing here gates on them for security.
 */
export function McpToolHintBadges({
  tool,
  className,
}: {
  tool: McpToolDescriptor;
  className?: string;
}) {
  const a = tool.annotations;
  if (!a) return null;
  const badges: Array<{ label: string; color: string }> = [];
  if (a.readOnlyHint === true) badges.push({ label: 'READ-ONLY', color: 'var(--color-success)' });
  if (isDestructiveTool(tool)) badges.push({ label: 'DESTRUCTIVE', color: 'var(--color-danger)' });
  if (a.idempotentHint === true) badges.push({ label: 'IDEMPOTENT', color: 'var(--sp-accent)' });
  if (a.openWorldHint === true) badges.push({ label: 'OPEN-WORLD', color: 'var(--color-warning)' });
  if (badges.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {badges.map((b) => (
        <span
          key={b.label}
          title="Server-declared hint (untrusted)"
          className={HINT_BADGE_CLASS}
          style={{
            color: b.color,
            background: `color-mix(in srgb, ${b.color} 14%, transparent)`,
          }}
        >
          {b.label}
        </span>
      ))}
    </div>
  );
}
