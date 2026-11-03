/** Every agent change, refusal and send, with Undo (Settings → MCP Server). */

import { Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/shared/utils';
import { undoActivity } from '../../lib/runtime';
import { type ActivityEntry, useMcpServerRuntimeStore } from '../../store/useMcpServerRuntimeStore';
import type { SettingsPrimitives } from './primitives';

const STATUS_STYLE: Record<ActivityEntry['status'], string> = {
  applied: 'text-emerald-600 dark:text-emerald-400',
  denied: 'text-amber-600 dark:text-amber-400',
  refused: 'text-sp-muted',
  failed: 'text-rose-600 dark:text-rose-400',
  undone: 'text-sp-muted line-through',
};

export function ActivityLog({ Group }: Pick<SettingsPrimitives, 'Group'>) {
  const activity = useMcpServerRuntimeStore((s) => s.activity);
  return (
    <Group label="Activity">
      {activity.length === 0 ? (
        <div className="py-3 text-sp-12 text-sp-muted" data-testid="mcp-activity-empty">
          No agent changes yet.
        </div>
      ) : (
        <ul className="divide-y divide-sp-line" data-testid="mcp-activity">
          {activity.slice(0, 50).map((entry) => (
            <li key={entry.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className={cn('truncate text-sp-12', STATUS_STYLE[entry.status])}>
                  {entry.summary}
                </div>
                <div className="truncate text-sp-11 text-sp-muted">
                  {entry.status} · {entry.tool} · {new Date(entry.at).toLocaleTimeString()}
                  {entry.client ? ` · ${entry.client}` : ''}
                  {entry.detail ? ` · ${entry.detail}` : ''}
                </div>
              </div>
              {entry.undoable && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void undoActivity(entry.id).then((result) =>
                      result.ok
                        ? toast.success('Change undone')
                        : toast.error('Could not undo', { description: result.error })
                    );
                  }}
                >
                  <Undo2 /> Undo
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Group>
  );
}
