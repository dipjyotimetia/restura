import { Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SaveToCollectionDialog } from './SaveToCollectionDialog';
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
import { saveTabBackToCollection } from '@/features/collections/lib/saveBack';
import { isElectron } from '@/lib/shared/platform';
import { cn } from '@/lib/shared/utils';
import { useRequestStore } from '@/store/useRequestStore';
import { isConnectionMode } from '@/types';
import type { RequestMode, TabModeOverride } from '@/types';

type NewRequestMode = RequestMode;

interface TabStripProps {
  onSaveToCollection?: (tabId: string) => void;
  /**
   * Switches the workspace to a mode that doesn't have its own RequestType
   * (graphql, websocket, socketio, kafka). The orchestrator owns the mode
   * override; the TabStrip just announces intent.
   */
  onChangeMode?: (mode: TabModeOverride) => void;
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
    if (isConnectionMode(mode)) {
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
  const activeTabRef = useRef<HTMLButtonElement>(null);

  const openSaveDialog = onSaveToCollection ?? setLocalSaveDialogTabId;

  useEffect(() => {
    if (renamingTabId) renameInputRef.current?.select();
  }, [renamingTabId]);

  // Keep the active tab visible when the strip overflows — otherwise a freshly
  // selected/created tab can land off-screen behind the cropped edge with no
  // affordance. `inline: 'nearest'` avoids jumping when it's already visible.
  useEffect(() => {
    // `scrollIntoView` is absent under jsdom — guard so test renders don't throw.
    if (typeof activeTabRef.current?.scrollIntoView === 'function') {
      activeTabRef.current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [activeTabId]);

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
    if (saveTabBackToCollection(tab.request, savedRequestId)) {
      clearTabDirty?.(tabId);
    }
  };

  return (
    <>
      <div className="shrink-0">
        <Floater
          radius="panel"
          elevation="float"
          className={cn(
            'sp-chrome flex items-center gap-0.5 p-1',
            // Horizontal scroll fallback when many tabs are open. We
            // intentionally hide the scrollbar — overflow is signalled by
            // the tabs themselves being cropped at the floater edge.
            'overflow-x-auto overflow-y-hidden no-scrollbar'
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
                    ref={isActive ? activeTabRef : undefined}
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
                        ? // Active uses a clean raised fill — no glow ring.
                          'text-sp-text bg-sp-surface-hi border border-sp-line-strong'
                        : 'text-sp-muted hover:text-sp-text hover:bg-sp-hover border border-transparent'
                    )}
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
                      // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- double-click rename shortcut on the label; the tab button is the primary control
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
                    <ContextMenuItem onClick={() => handleSaveBack(tab.id, tab.savedRequestId!)}>
                      Save changes
                    </ContextMenuItem>
                  )}
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => duplicateTab(tab.id)}>Duplicate</ContextMenuItem>
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
            {/* align="start" drops the menu away from the method/URL row;
                sideOffset clears the floater's bottom edge (trigger sits 8px
                above it) so the menu never overlaps the strip. */}
            <DropdownMenuContent align="start" sideOffset={10}>
              <DropdownMenuItem className="gap-2" onClick={() => handleNewTab('http')}>
                <ProtoChip protocol="HTTP" className="w-12 justify-center" />
                HTTP request
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2" onClick={() => handleNewTab('graphql')}>
                <ProtoChip protocol="GQL" className="w-12 justify-center" />
                GraphQL request
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2" onClick={() => handleNewTab('grpc')}>
                <ProtoChip protocol="GRPC" className="w-12 justify-center" />
                gRPC request
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2" onClick={() => handleNewTab('websocket')}>
                <ProtoChip protocol="WS" className="w-12 justify-center" />
                WebSocket
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2" onClick={() => handleNewTab('socketio')}>
                <ProtoChip protocol="SOCKETIO" className="w-12 justify-center" />
                Socket.IO
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2" onClick={() => handleNewTab('sse')}>
                <ProtoChip protocol="SSE" className="w-12 justify-center" />
                SSE stream
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2" onClick={() => handleNewTab('mcp')}>
                <ProtoChip protocol="MCP" className="w-12 justify-center" />
                MCP request
              </DropdownMenuItem>
              {isElectron() && (
                <DropdownMenuItem className="gap-2" onClick={() => handleNewTab('kafka')}>
                  <ProtoChip protocol="KAFKA" className="w-12 justify-center" />
                  Kafka consumer
                </DropdownMenuItem>
              )}
              {isElectron() && (
                <DropdownMenuItem className="gap-2" onClick={() => handleNewTab('mqtt')}>
                  <ProtoChip protocol="MQTT" className="w-12 justify-center" />
                  MQTT client
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
