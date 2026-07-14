/**
 * Bottom panel showing live run state. Steps / Variables / Logs tabs.
 * Auto-opens when a run starts; per-tab selectors narrow subscriptions
 * so a log append doesn't re-render Variables.
 */
'use client';

import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/shared/utils';
import { useFlowRunStore } from '../../store/useFlowRunStore';

const STATUS_BADGE = {
  idle: 'mono',
  pending: 'mono',
  running: 'info',
  success: 'success',
  failed: 'destructive',
  skipped: 'mono',
} as const;

export function RunMonitorPanel() {
  const isRunning = useFlowRunStore((s) => s.isRunning);
  const finalStatus = useFlowRunStore((s) => s.finalStatus);
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // Auto-open when a run starts; user can close manually.
  useEffect(() => {
    if (isRunning) {
      setOpen(true);
      setCollapsed(false);
    }
  }, [isRunning]);

  if (!open) return null;

  return (
    <div
      className={cn(
        'border-t border-sp-line bg-sp-surface',
        'flex flex-col',
        collapsed ? 'h-9' : 'h-56'
      )}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-sp-line">
        <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          Run Monitor
        </div>
        {isRunning ? (
          <Badge variant="info" className="h-4 px-1.5 text-[10px]">
            Running…
          </Badge>
        ) : finalStatus ? (
          <Badge
            variant={
              finalStatus === 'success'
                ? 'success'
                : finalStatus === 'stopped'
                  ? 'warning'
                  : 'destructive'
            }
            className="h-4 px-1.5 text-[10px]"
          >
            {finalStatus}
          </Badge>
        ) : null}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2"
          onClick={() => setOpen(false)}
          title="Close"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
      {!collapsed && (
        <Tabs defaultValue="steps" className="flex-1 flex flex-col min-h-0">
          <TabsList className="px-3 -mb-px">
            <TabsTrigger value="steps">Steps</TabsTrigger>
            <TabsTrigger value="variables">Variables</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
          </TabsList>
          <TabsContent value="steps" className="flex-1 min-h-0 mt-0">
            <StepsTab />
          </TabsContent>
          <TabsContent value="variables" className="flex-1 min-h-0 mt-0">
            <VariablesTab />
          </TabsContent>
          <TabsContent value="logs" className="flex-1 min-h-0 mt-0">
            <LogsTab />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

/** Pretty-print a captured value: compact re-formatted JSON, else raw. */
function prettyValue(v: string): string {
  let out: string;
  try {
    out = JSON.stringify(JSON.parse(v));
  } catch {
    out = v;
  }
  return out.length > 80 ? `${out.slice(0, 77)}…` : out;
}

function StepsTab() {
  const nodeStates = useFlowRunStore((s) => s.nodeStates);
  const entries = Object.entries(nodeStates);
  if (entries.length === 0) {
    return <div className="text-xs text-muted-foreground italic p-3">No steps executed yet.</div>;
  }
  return (
    <ScrollArea className="h-full">
      <div className="p-3 space-y-1">
        {entries.map(([nodeId, state]) => (
          <div
            key={nodeId}
            className="flex items-center gap-2 text-xs px-2 py-1 rounded-md border border-sp-line"
          >
            <Badge
              variant={STATUS_BADGE[state.status]}
              className="h-4 px-1.5 text-[10px] flex-shrink-0"
            >
              {state.status}
            </Badge>
            <span className="font-mono text-[10px] text-muted-foreground truncate flex-shrink-0">
              {nodeId.length > 16 ? `${nodeId.slice(0, 14)}…` : nodeId}
            </span>
            {state.duration !== undefined && (
              <span className="font-mono text-[10px] text-sp-muted">{state.duration}ms</span>
            )}
            {state.error && (
              <span className="text-red-400 truncate flex-1 text-[11px]" title={state.error}>
                {state.error}
              </span>
            )}
            {state.extractedVariables &&
              Object.entries(state.extractedVariables).map(([k, v]) => (
                <span
                  key={k}
                  className="font-mono text-[10px] text-sp-muted truncate max-w-[45%]"
                  title={`${k}: ${v}`}
                >
                  {k}={prettyValue(v)}
                </span>
              ))}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function VariablesTab() {
  const variables = useFlowRunStore((s) => s.variables);
  const entries = Object.entries(variables);
  if (entries.length === 0) {
    return <div className="text-xs text-muted-foreground italic p-3">No variables yet.</div>;
  }
  return (
    <ScrollArea className="h-full">
      <div className="p-3 space-y-1">
        {entries.map(([k, v]) => (
          <div
            key={k}
            className="flex items-start gap-2 text-xs px-2 py-1 rounded-md border border-sp-line"
          >
            <span className="font-mono text-[11px] font-semibold text-foreground flex-shrink-0">
              {k}
            </span>
            <span className="text-muted-foreground">=</span>
            <span className="font-mono text-[11px] text-muted-foreground break-all" title={v}>
              {v.length > 120 ? `${v.slice(0, 117)}…` : v}
            </span>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function LogsTab() {
  const logs = useFlowRunStore((s) => s.logs);
  if (logs.length === 0) {
    return <div className="text-xs text-muted-foreground italic p-3">No logs yet.</div>;
  }
  return (
    <ScrollArea className="h-full">
      <div className="p-3 space-y-0.5 font-mono text-[11px]">
        {logs.map((l, i) => (
          <div
            key={i}
            className={cn(
              'flex items-start gap-2',
              l.level === 'error' && 'text-red-400',
              l.level === 'warn' && 'text-amber-400'
            )}
          >
            <span className="text-sp-dim flex-shrink-0">
              {new Date(l.timestamp).toLocaleTimeString(undefined, {
                hour12: false,
              })}
            </span>
            <span className="break-all">{l.message}</span>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
