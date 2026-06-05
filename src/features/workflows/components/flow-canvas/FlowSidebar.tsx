/**
 * Left rail with two drag sources: the node-kind palette and the
 * filtered list of saved collection requests. MIME-typed payloads let
 * FlowCanvas's onDrop discriminate between palette drops and saved-
 * request drops.
 */
'use client';

import { useMemo, useState, type DragEvent } from 'react';
import type { FlowNodeKind } from '@/types';
import { useCollectionStore } from '@/store/useCollectionStore';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/shared/utils';
import { flattenRequests, type RequestSummary } from '../../lib/collectionHelpers';
import { methodBadgeVariant } from '../../lib/methodBadge';
import {
  GitBranch,
  Split,
  Variable,
  Clock,
  Code2,
  FileText,
  Eye,
  GitFork,
  Repeat,
  RotateCw,
  ShieldAlert,
  Workflow as WorkflowIcon,
  Search,
  Send,
  Radio,
  Plug,
  Sparkles,
} from 'lucide-react';

export const FLOW_DRAG_KIND_MIME = 'application/x-restura-flow-kind';
export const FLOW_DRAG_REQUEST_MIME = 'application/x-restura-flow-request';

interface PaletteEntry {
  kind: FlowNodeKind;
  label: string;
  icon: typeof GitBranch;
  iconClass: string;
  blurb: string;
}

const PALETTE: PaletteEntry[] = [
  {
    kind: 'condition',
    label: 'Condition',
    icon: GitBranch,
    iconClass: 'text-violet-400',
    blurb: 'Branch on a script expression',
  },
  {
    kind: 'switch',
    label: 'Switch',
    icon: Split,
    iconClass: 'text-indigo-400',
    blurb: 'Route to one of many branches',
  },
  {
    kind: 'setVariable',
    label: 'Set Variable',
    icon: Variable,
    iconClass: 'text-blue-400',
    blurb: 'Assign workflow variables',
  },
  {
    kind: 'delay',
    label: 'Delay',
    icon: Clock,
    iconClass: 'text-amber-400',
    blurb: 'Pause for N ms',
  },
  {
    kind: 'transform',
    label: 'Transform',
    icon: Code2,
    iconClass: 'text-purple-400',
    blurb: 'Run a JS script',
  },
  {
    kind: 'template',
    label: 'Template',
    icon: FileText,
    iconClass: 'text-sky-400',
    blurb: 'Render {{vars}} into a variable',
  },
  {
    kind: 'display',
    label: 'Display',
    icon: Eye,
    iconClass: 'text-emerald-400',
    blurb: 'Show a value in the run monitor',
  },
  {
    kind: 'parallel',
    label: 'Parallel',
    icon: GitFork,
    iconClass: 'text-cyan-400',
    blurb: 'Fan out & rejoin branches',
  },
  {
    kind: 'forEach',
    label: 'For Each',
    icon: Repeat,
    iconClass: 'text-orange-400',
    blurb: 'Iterate over a list',
  },
  {
    kind: 'loop',
    label: 'Loop',
    icon: RotateCw,
    iconClass: 'text-lime-400',
    blurb: 'Repeat while/until a condition',
  },
  {
    kind: 'tryCatch',
    label: 'Try / Catch',
    icon: ShieldAlert,
    iconClass: 'text-yellow-400',
    blurb: 'Recover from errors',
  },
  {
    kind: 'subWorkflow',
    label: 'Sub-workflow',
    icon: WorkflowIcon,
    iconClass: 'text-fuchsia-400',
    blurb: 'Call another workflow',
  },
  {
    kind: 'sseSubscribe',
    label: 'SSE Subscribe',
    icon: Radio,
    iconClass: 'text-pink-400',
    blurb: 'Listen to an SSE stream',
  },
  {
    kind: 'wsExchange',
    label: 'WebSocket',
    icon: Plug,
    iconClass: 'text-teal-400',
    blurb: 'Send → wait for match',
  },
  {
    kind: 'mcpCall',
    label: 'MCP Call',
    icon: Sparkles,
    iconClass: 'text-rose-400',
    blurb: 'Call an MCP JSON-RPC method',
  },
];

interface FlowSidebarProps {
  collectionId: string;
}

export function FlowSidebar({ collectionId }: FlowSidebarProps) {
  const collections = useCollectionStore((s) => s.collections);
  const collection = collections.find((c) => c.id === collectionId);
  const [filter, setFilter] = useState('');

  const requests = useMemo<RequestSummary[]>(
    () => (collection ? flattenRequests(collection.items) : []),
    [collection]
  );

  const filtered = useMemo(() => {
    if (!filter.trim()) return requests;
    const f = filter.toLowerCase();
    return requests.filter(
      (r) =>
        r.name.toLowerCase().includes(f) ||
        r.path.toLowerCase().includes(f) ||
        (r.method && r.method.toLowerCase().includes(f))
    );
  }, [requests, filter]);

  const handlePaletteDragStart = (e: DragEvent<HTMLDivElement>, kind: FlowNodeKind) => {
    e.dataTransfer.setData(FLOW_DRAG_KIND_MIME, kind);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const handleRequestDragStart = (e: DragEvent<HTMLDivElement>, req: RequestSummary) => {
    e.dataTransfer.setData(
      FLOW_DRAG_REQUEST_MIME,
      JSON.stringify({
        id: req.id,
        name: req.name,
        // Drop handler uses this to choose the right node kind — SSE
        // requests become sseSubscribe nodes, MCP become mcpCall, etc.
        kind: req.kind,
      })
    );
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div className="flex flex-col h-full w-56 border-r border-sp-line bg-sp-surface">
      <div className="px-2 pt-2">
        <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground px-2 mb-1">
          Add Node
        </div>
        <ScrollArea className="max-h-[40vh]">
          <div className="space-y-1 pr-1">
            {PALETTE.map((entry) => {
              const Icon = entry.icon;
              return (
                <div
                  key={entry.kind}
                  draggable
                  onDragStart={(e) => handlePaletteDragStart(e, entry.kind)}
                  className={cn(
                    'flex items-start gap-2 px-2 py-1.5 rounded-md cursor-grab',
                    'hover:bg-sp-hover active:cursor-grabbing',
                    'border border-transparent hover:border-sp-line'
                  )}
                >
                  <Icon className={cn('h-4 w-4 mt-0.5 flex-shrink-0', entry.iconClass)} />
                  <div className="min-w-0">
                    <div className="text-xs font-medium leading-tight">{entry.label}</div>
                    <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                      {entry.blurb}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </div>

      <div className="border-t border-sp-line mt-2 pt-2 px-2 flex-1 min-h-0 flex flex-col">
        <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground px-2 mb-1">
          Requests
        </div>
        <div className="relative mb-1.5">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter requests…"
            className="h-7 pl-7 text-xs"
          />
        </div>
        <ScrollArea className="flex-1 -mx-2 px-2">
          <div className="space-y-0.5 pr-1">
            {filtered.length === 0 ? (
              <div className="text-xs text-muted-foreground italic px-2 py-2">
                {requests.length === 0 ? 'No requests in this collection yet.' : 'No matches.'}
              </div>
            ) : (
              filtered.map((req) => (
                <div
                  key={req.id}
                  draggable
                  onDragStart={(e) => handleRequestDragStart(e, req)}
                  className={cn(
                    'flex items-center gap-1.5 px-2 py-1 rounded-md cursor-grab',
                    'hover:bg-sp-hover active:cursor-grabbing',
                    'border border-transparent hover:border-sp-line'
                  )}
                  title={req.path}
                >
                  {req.method ? (
                    <Badge variant={methodBadgeVariant(req.method)} className="flex-shrink-0">
                      {req.method.length > 4 ? req.method.slice(0, 4) : req.method}
                    </Badge>
                  ) : (
                    <Send className="h-3 w-3 text-muted-foreground" />
                  )}
                  <span className="text-xs truncate">{req.name}</span>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
