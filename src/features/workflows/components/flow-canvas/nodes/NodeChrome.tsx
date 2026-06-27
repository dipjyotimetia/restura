/**
 * Shared "chrome" for every custom React Flow node: glass card, status
 * indicator strip, optional kind badge, and the children slot that each
 * node-kind component fills with its own body.
 *
 * Phase 4: subscribes to `useFlowRunStore` by nodeId to render live
 * execution state (running / success / failed / skipped). Failed nodes
 * surface their error message through a Tooltip on the status dot.
 *
 * Static `status` prop overrides the store — useful in tests / Storybook
 * where there's no run state to read.
 */
import { Loader2, AlertCircle, CheckCircle2, SkipForward } from 'lucide-react';
import type { ReactNode } from 'react';
import { useFlowRunStore, type FlowRunNodeStatus } from '../../../store/useFlowRunStore';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/shared/utils';

export type NodeStatus = FlowRunNodeStatus;

interface NodeChromeProps {
  /** React Flow node id — used to look up live status from the run store. */
  nodeId: string;
  /** Human label shown in the top-left corner (e.g. "REQUEST"). */
  kindLabel: string;
  /** Override the live status — useful in tests / static previews. */
  statusOverride?: NodeStatus;
  selected?: boolean;
  className?: string;
  children: ReactNode;
}

const STATUS_RING: Record<NodeStatus, string> = {
  idle: 'ring-1 ring-sp-line',
  pending: 'ring-1 ring-sp-line',
  running: 'ring-2 ring-blue-500/60',
  success: 'ring-2 ring-emerald-500/60',
  failed: 'ring-2 ring-red-500/60',
  skipped: 'ring-1 ring-sp-line opacity-60',
};

const STATUS_DOT: Record<NodeStatus, string> = {
  idle: 'bg-muted-foreground/40',
  pending: 'bg-muted-foreground/40',
  running: 'bg-blue-500',
  success: 'bg-emerald-500',
  failed: 'bg-red-500',
  skipped: 'bg-muted-foreground/30',
};

export function NodeChrome({
  nodeId,
  kindLabel,
  statusOverride,
  selected = false,
  className,
  children,
}: NodeChromeProps) {
  const liveState = useFlowRunStore((s) => s.nodeStates[nodeId]);
  const status = statusOverride ?? liveState?.status ?? 'idle';
  const errorMsg = liveState?.error;
  const duration = liveState?.duration;

  const StatusIndicator = (
    <span className="inline-flex items-center gap-1.5">
      {status === 'running' ? (
        <Loader2 className="w-3 h-3 text-blue-500 animate-spin" aria-label="Running" />
      ) : status === 'success' ? (
        <CheckCircle2 className="w-3 h-3 text-emerald-500" aria-label="Success" />
      ) : status === 'failed' ? (
        <AlertCircle className="w-3 h-3 text-red-500" aria-label="Failed" />
      ) : status === 'skipped' ? (
        <SkipForward className="w-3 h-3 text-muted-foreground" aria-label="Skipped" />
      ) : (
        <span
          className={cn('inline-block w-1.5 h-1.5 rounded-full', STATUS_DOT[status])}
          aria-hidden
        />
      )}
      <span className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
        {kindLabel}
      </span>
      {duration !== undefined && status !== 'running' && (
        <span className="font-mono text-[10px] text-sp-muted ml-auto">{duration}ms</span>
      )}
    </span>
  );

  return (
    <div
      className={cn(
        'glass-2 rounded-lg px-3 py-2 min-w-[200px] max-w-[280px]',
        'transition-all duration-150',
        STATUS_RING[status],
        status === 'running' && 'animate-pulse',
        selected && 'ring-2 ring-primary/70',
        className
      )}
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        {status === 'failed' && errorMsg ? (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1.5 cursor-default"
                  aria-label={`Failure: ${errorMsg}`}
                >
                  {StatusIndicator}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs text-xs">
                <div className="font-semibold text-red-300 mb-0.5">Failed</div>
                <div className="text-muted-foreground whitespace-pre-wrap break-words">
                  {errorMsg}
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          StatusIndicator
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}
