import { useRequestStore } from '@/store/useRequestStore';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Plus, X } from 'lucide-react';
import type { RequestType } from '@/types';

const PROTOCOL_LABEL: Record<RequestType, string> = {
  http: 'HTTP',
  grpc: 'gRPC',
  sse: 'SSE',
  mcp: 'MCP',
};

export function TabBar() {
  const tabs = useRequestStore((s) => s.tabs);
  const activeTabId = useRequestStore((s) => s.activeTabId);
  const switchTab = useRequestStore((s) => s.switchTab);
  const closeTab = useRequestStore((s) => s.closeTab);
  const closeOtherTabs = useRequestStore((s) => s.closeOtherTabs);
  const closeAllTabs = useRequestStore((s) => s.closeAllTabs);
  const duplicateTab = useRequestStore((s) => s.duplicateTab);
  const createNewRequest = useRequestStore((s) => s.createNewRequest);

  return (
    <div className="flex items-center gap-1 border-b bg-background px-2 py-1">
      <ScrollArea className="flex-1">
        <div className="flex items-center gap-1" role="tablist">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <ContextMenu key={tab.id}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    aria-label={tab.request.name}
                    onClick={() => switchTab(tab.id)}
                    className={[
                      'group flex items-center gap-2 rounded-md px-3 py-1 text-sm shrink-0',
                      isActive
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-accent/50',
                    ].join(' ')}
                  >
                    <span className="text-xs font-mono opacity-60">
                      {PROTOCOL_LABEL[tab.request.type]}
                    </span>
                    <span className="truncate max-w-[16ch]">{tab.request.name}</span>
                    {tab.isDirty && (
                      <span
                        aria-label="unsaved changes"
                        className="size-1.5 rounded-full bg-foreground/60"
                      />
                    )}
                    <span
                      role="button"
                      aria-label={`close ${tab.request.name}`}
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(tab.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.stopPropagation();
                          closeTab(tab.id);
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 hover:bg-accent rounded p-0.5 cursor-pointer"
                    >
                      <X className="size-3" />
                    </span>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => duplicateTab(tab.id)}>
                    Duplicate
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => closeTab(tab.id)}>
                    Close
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => closeOtherTabs(tab.id)}>
                    Close Others
                  </ContextMenuItem>
                  <ContextMenuItem onClick={closeAllTabs}>Close All</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" aria-label="new request" className="shrink-0">
            <Plus className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => createNewRequest('http')}>
            HTTP request
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => createNewRequest('grpc')}>
            gRPC request
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => createNewRequest('sse')}>
            SSE request
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => createNewRequest('mcp')}>
            MCP request
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
