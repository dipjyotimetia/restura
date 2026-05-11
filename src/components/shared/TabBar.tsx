import { useEffect, useRef, useState } from 'react';
import { useRequestStore } from '@/store/useRequestStore';
import { useCollectionStore } from '@/store/useCollectionStore';
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
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { BookmarkCheck, Plus, X } from 'lucide-react';
import type { RequestType } from '@/types';
import { SaveToCollectionDialog } from './SaveToCollectionDialog';

const PROTOCOL_LABEL: Record<RequestType, string> = {
  http: 'HTTP',
  grpc: 'gRPC',
  sse: 'SSE',
  mcp: 'MCP',
};

interface TabBarProps {
  onSaveToCollection?: (tabId: string) => void;
}

export function TabBar({ onSaveToCollection }: TabBarProps) {
  const tabs = useRequestStore((s) => s.tabs);
  const activeTabId = useRequestStore((s) => s.activeTabId);
  const switchTab = useRequestStore((s) => s.switchTab);
  const closeTab = useRequestStore((s) => s.closeTab);
  const closeOtherTabs = useRequestStore((s) => s.closeOtherTabs);
  const closeAllTabs = useRequestStore((s) => s.closeAllTabs);
  const duplicateTab = useRequestStore((s) => s.duplicateTab);
  const createNewRequest = useRequestStore((s) => s.createNewRequest);
  const reorderTabs = useRequestStore((s) => s.reorderTabs);
  const renameTab = useRequestStore((s) => s.renameTab);
  const clearTabDirty = useRequestStore((s) => s.clearTabDirty);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Only used when no onSaveToCollection prop is provided (standalone usage / tests)
  const [localSaveDialogTabId, setLocalSaveDialogTabId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const openSaveDialog = onSaveToCollection ?? setLocalSaveDialogTabId;

  // Focus and select the rename input when a rename begins
  useEffect(() => {
    if (renamingTabId) {
      renameInputRef.current?.select();
    }
  }, [renamingTabId]);

  const startRename = (tabId: string, currentName: string) => {
    setRenamingTabId(tabId);
    setRenameValue(currentName);
  };

  const commitRename = () => {
    if (renamingTabId && renameValue.trim()) {
      renameTab(renamingTabId, renameValue.trim());
    }
    setRenamingTabId(null);
  };

  const cancelRename = () => setRenamingTabId(null);

  const handleSaveBack = (tabId: string, savedRequestId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    useCollectionStore.getState().updateAnyCollectionItem(savedRequestId, {
      name: tab.request.name,
      request: tab.request,
    });
    clearTabDirty(tabId);
  };

  return (
    <>
      <div className="flex items-center gap-1 border-b glass-border-subtle glass-2 px-2 py-1">
        <ScrollArea className="flex-1">
          <div
            className="flex items-center gap-1"
            role="tablist"
            aria-label="Request tabs"
            onKeyDown={(e) => {
              const idx = tabs.findIndex((t) => t.id === activeTabId);
              if (e.key === 'ArrowRight') {
                e.preventDefault();
                const next = tabs[(idx + 1) % tabs.length];
                if (next) switchTab(next.id);
              } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
                if (prev) switchTab(prev.id);
              } else if (e.key === 'Delete' && activeTabId) {
                e.preventDefault();
                closeTab(activeTabId);
              }
            }}
          >
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              const isRenaming = tab.id === renamingTabId;

              return (
                <ContextMenu key={tab.id}>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      aria-label={tab.request.name}
                      tabIndex={isActive ? 0 : -1}
                      onClick={() => switchTab(tab.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          switchTab(tab.id);
                        }
                      }}
                      draggable={!isRenaming}
                      onDragStart={(e) => {
                        setDraggingId(tab.id);
                        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (!draggingId || draggingId === tab.id) return;
                        const ids = tabs.map((t) => t.id);
                        const fromIdx = ids.indexOf(draggingId);
                        const toIdx = ids.indexOf(tab.id);
                        if (fromIdx === -1 || toIdx === -1) return;
                        ids.splice(fromIdx, 1);
                        ids.splice(toIdx, 0, draggingId);
                        reorderTabs(ids);
                        setDraggingId(null);
                      }}
                      onDragEnd={() => setDraggingId(null)}
                      className={[
                        'group flex items-center gap-2 rounded-md px-3 py-1 text-sm shrink-0 transition-colors duration-150',
                        isActive
                          ? 'glass-1 text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground hover:bg-black/[0.04] dark:hover:bg-white/[0.08]',
                      ].join(' ')}
                    >
                      <span className="text-xs font-mono opacity-60">
                        {PROTOCOL_LABEL[tab.request.type]}
                      </span>

                      {isRenaming ? (
                        <input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') commitRename();
                            if (e.key === 'Escape') cancelRename();
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="w-[14ch] bg-transparent border-b border-primary outline-none text-sm text-foreground"
                          aria-label="Rename request"
                        />
                      ) : (
                        <span
                          className="truncate max-w-[16ch]"
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            switchTab(tab.id);
                            startRename(tab.id, tab.request.name);
                          }}
                        >
                          {tab.request.name}
                        </span>
                      )}

                      {tab.isDirty && tab.savedRequestId && (
                        <span
                          role="button"
                          aria-label="Save changes to collection"
                          tabIndex={-1}
                          title="Save changes to collection"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSaveBack(tab.id, tab.savedRequestId!);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.stopPropagation();
                              handleSaveBack(tab.id, tab.savedRequestId!);
                            }
                          }}
                          className="opacity-0 group-hover:opacity-100 hover:bg-accent rounded p-0.5 cursor-pointer text-primary"
                        >
                          <BookmarkCheck className="size-3" />
                        </span>
                      )}

                      {tab.isDirty && !tab.savedRequestId && (
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
                    <ContextMenuItem
                      onClick={() => {
                        switchTab(tab.id);
                        startRename(tab.id, tab.request.name);
                      }}
                    >
                      Rename
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => openSaveDialog(tab.id)}>
                      Save to Collection…
                    </ContextMenuItem>
                    {tab.isDirty && tab.savedRequestId && (
                      <ContextMenuItem
                        onClick={() => handleSaveBack(tab.id, tab.savedRequestId!)}
                      >
                        Save changes
                      </ContextMenuItem>
                    )}
                    <ContextMenuSeparator />
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

      {/* Fallback dialog when used without onSaveToCollection prop (e.g. in tests or standalone) */}
      {localSaveDialogTabId && (
        <SaveToCollectionDialog
          tabId={localSaveDialogTabId}
          open={true}
          onOpenChange={(o) => { if (!o) setLocalSaveDialogTabId(null); }}
        />
      )}
    </>
  );
}
