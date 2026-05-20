import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useRequestStore } from '@/store/useRequestStore';
import { useCollectionStore } from '@/store/useCollectionStore';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Floater, ProtoChip } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';
import { isElectron } from '@/lib/shared/platform';
import { SaveToCollectionDialog } from './SaveToCollectionDialog';

type NewRequestMode =
  | 'http' | 'grpc' | 'sse' | 'mcp'
  | 'graphql' | 'websocket' | 'socketio' | 'kafka';

interface TabStripProps {
  onSaveToCollection?: (tabId: string) => void;
  /**
   * Switches the workspace to a mode that doesn't have its own RequestType
   * (graphql, websocket, socketio, kafka). The orchestrator owns the mode
   * override; the TabStrip just announces intent.
   */
  onChangeMode?: (mode: 'graphql' | 'websocket' | 'socketio' | 'kafka') => void;
}

/**
 * Spatial Depth tab strip — replaces the legacy underlined-tab bar.
 *
 * Behaviour preserved from the previous implementation:
 *   - drag-and-drop reorder (native HTML5 DnD)
 *   - context menu (rename / save / duplicate / close / close others / close all)
 *   - inline rename on double-click
 *   - dirty indicator (dot + save-back affordance when bound to a collection)
 *   - keyboard navigation (arrow-left/right to switch, Delete to close)
 *   - new-tab dropdown at the right edge
 *
 * Visual contract from the design handoff (§5):
 *   - Floater(pill, float), padded 4 px, horizontal scroll on overflow
 *   - Per-tab: ProtoChip + name (max ~130px) + dirty dot + × close
 *   - Active tab: `bg-sp-active` + inset 1px ring of accent glow
 */
export function TabStrip({ onSaveToCollection, onChangeMode }: TabStripProps) {
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

  const handleNewTab = (mode: NewRequestMode) => {
    if (mode === 'graphql' || mode === 'websocket' || mode === 'socketio' || mode === 'kafka') {
      onChangeMode?.(mode);
      return;
    }
    createNewRequest(mode);
  };

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [localSaveDialogTabId, setLocalSaveDialogTabId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const openSaveDialog = onSaveToCollection ?? setLocalSaveDialogTabId;

  useEffect(() => {
    if (renamingTabId) renameInputRef.current?.select();
  }, [renamingTabId]);

  const startRename = (tabId: string, currentName: string) => {
    setRenamingTabId(tabId);
    setRenameValue(currentName);
  };

  const commitRename = () => {
    if (renamingTabId && renameValue.trim()) {
      renameTab?.(renamingTabId, renameValue.trim());
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
    clearTabDirty?.(tabId);
  };

  return (
    <>
      <div className="px-3 pt-2 pb-1 shrink-0">
        <Floater
          radius="pill"
          elevation="float"
          className={cn(
            'flex items-center gap-0.5 p-1',
            // Horizontal scroll fallback when many tabs are open. We
            // intentionally hide the scrollbar — overflow is signalled by
            // the tabs themselves being cropped at the floater edge.
            'overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden',
            '[scrollbar-width:none]'
          )}
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
                    className={cn(
                      'group inline-flex items-center gap-2 shrink-0',
                      'rounded-sp-btn px-3 py-1.5 transition-colors',
                      'font-mono text-sp-11-5',
                      isActive
                        ? // Active uses sp-active fill + inset accent ring.
                          'text-sp-text bg-sp-active'
                        : 'text-sp-muted hover:text-sp-text hover:bg-sp-hover'
                    )}
                    style={
                      isActive
                        ? { boxShadow: 'inset 0 0 0 1px var(--sp-accent-glow-55)' }
                        : undefined
                    }
                  >
                    <ProtoChip protocol={tab.modeOverride ?? tab.request.type} />

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
                        className={cn(
                          'bg-transparent outline-none border-b border-sp-accent',
                          'text-sp-text text-sp-12 font-sans',
                          'min-w-[8ch] max-w-[130px]'
                        )}
                        aria-label="Rename request"
                      />
                    ) : (
                      <span
                        className="truncate font-sans text-sp-12"
                        style={{ maxWidth: 130 }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          switchTab(tab.id);
                          startRename(tab.id, tab.request.name);
                        }}
                      >
                        {tab.request.name}
                      </span>
                    )}

                    {/* Dirty dot — only when truly unsaved (no bound saved
                        request). When there *is* a bound request we still want
                        to fall back to the save-back affordance so users can
                        push dirty changes without the context menu. */}
                    {tab.isDirty && !tab.savedRequestId && (
                      <span
                        aria-label="unsaved changes"
                        className="block size-[5px] rounded-full sp-accent-glow shrink-0"
                        style={{ background: 'var(--sp-accent)' }}
                      />
                    )}

                    {tab.isDirty && tab.savedRequestId && (
                      <span
                        role="button"
                        aria-label="Save changes to collection"
                        tabIndex={-1}
                        title="Save changes"
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
                        className={cn(
                          'block size-[5px] rounded-full sp-accent-glow shrink-0',
                          'cursor-pointer'
                        )}
                        style={{ background: 'var(--sp-accent)' }}
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
                      className={cn(
                        'inline-flex items-center justify-center size-4 rounded-[5px]',
                        'opacity-0 group-hover:opacity-100',
                        'hover:bg-sp-hover text-sp-muted hover:text-sp-text',
                        'transition-colors cursor-pointer',
                        isActive && 'opacity-70'
                      )}
                    >
                      <X className="size-3" aria-hidden="true" />
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
                  <ContextMenuItem onClick={() => closeTab(tab.id)}>Close</ContextMenuItem>
                  <ContextMenuItem onClick={() => closeOtherTabs(tab.id)}>
                    Close Others
                  </ContextMenuItem>
                  <ContextMenuItem onClick={closeAllTabs}>Close All</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="new request"
                title="New request"
                className={cn(
                  'inline-flex items-center justify-center size-7 shrink-0 ml-0.5',
                  'rounded-sp-btn text-sp-muted',
                  'hover:bg-sp-hover hover:text-sp-text transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
                )}
              >
                <Plus className="size-3.5" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleNewTab('http')}>
                HTTP request
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleNewTab('graphql')}>
                GraphQL request
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleNewTab('grpc')}>
                gRPC request
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleNewTab('websocket')}>
                WS
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleNewTab('socketio')}>
                Socket.IO
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleNewTab('sse')}>
                SSE stream
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleNewTab('mcp')}>
                MCP request
              </DropdownMenuItem>
              {isElectron() && (
                <DropdownMenuItem onClick={() => handleNewTab('kafka')}>
                  Kafka consumer
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </Floater>
      </div>

      {/* Fallback dialog when used without onSaveToCollection prop
          (e.g. accessibility tests / standalone usage). */}
      {localSaveDialogTabId && (
        <SaveToCollectionDialog
          tabId={localSaveDialogTabId}
          open={true}
          onOpenChange={(o) => {
            if (!o) setLocalSaveDialogTabId(null);
          }}
        />
      )}
    </>
  );
}

// Keep the previous symbol so existing import sites (Home + tests) compile
// without churn. New code should prefer `TabStrip`.
export const TabBar = TabStrip;
