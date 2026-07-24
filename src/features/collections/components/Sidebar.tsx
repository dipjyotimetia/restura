import { Activity, Folder, History, Workflow as WorkflowIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import RunsPanel from '@/components/shared/RunsPanel';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import { redactCollectionSecrets } from '@/lib/shared/collection-secret-redaction';
import { selectFavoriteIds, selectHistoryCount } from '@/store/selectors';
import { useCollectionStore } from '@/store/useCollectionStore';
import { isElectronEnvironment, useFileCollectionStore } from '@/store/useFileCollectionStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useMockStore } from '@/store/useMockStore';
import { useRequestStore } from '@/store/useRequestStore';
import { type OwsStoredWorkflow, useWorkflowStore } from '@/store/useWorkflowStore';
import type { ActivePanel, CollectionItem } from '@/types';
import { useCollectionSidebarCommands } from '../hooks/useCollectionSidebarCommands';
import { duplicateRequestItem, makeFolderItem, makeRequestItem } from '../lib/itemFactory';
import {
  folderPathTo,
  moveWouldCollide,
  parentFolderIdOf,
  siblingNamesForParent,
  uniqueName,
} from '../lib/names';
import { CollectionDirectoryPicker } from './CollectionDirectoryPicker';
import { selectionKey, type TreeActions, type TreeState } from './CollectionTree';
import { ConflictDialog } from './ConflictDialog';
import { SidebarCollectionsPanel } from './SidebarCollectionsPanel';
import { SidebarHistoryPanel } from './SidebarHistoryPanel';
import { SidebarWorkflowsPanel } from './SidebarWorkflowsPanel';
import {
  CollectionRunnerDialog,
  CollectionSettingsDialog,
  DocsViewer,
  ExportSecretsDialog,
  GitDialog,
  WorkflowBuilder,
  WorkflowExecutor,
} from './sidebarLazyDialogs';

interface SidebarProps {
  activePanel?: ActivePanel | null;
}

const HISTORY_PAGE_SIZE = 20;

/** Stable "nothing collapsed" set used while a search is active. */
const EMPTY_COLLAPSED: Set<string> = new Set();

/** Immutable Set toggle for the collapse-state updaters. */
const toggledSet = (prev: Set<string>, id: string): Set<string> => {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
};

/**
 * Event-time store reads for the duplicate-name guards. Reading via
 * getState() (not the subscribed `collections`) keeps the handler callbacks
 * stable so the memoized tree rows don't re-render on unrelated changes.
 */
const getCollectionById = (collectionId: string) =>
  useCollectionStore.getState().getCollectionById(collectionId);

const siblingNames = (collectionId: string, parentId?: string) => {
  const collection = getCollectionById(collectionId);
  return collection ? siblingNamesForParent(collection, parentId) : [];
};

function Sidebar({ activePanel }: SidebarProps) {
  const { collections, addItemToCollection, removeCollectionItem, moveCollectionItem } =
    useCollectionStore(
      useShallow((s) => ({
        collections: s.collections,
        addItemToCollection: s.addItemToCollection,
        removeCollectionItem: s.removeCollectionItem,
        moveCollectionItem: s.moveCollectionItem,
      }))
    );

  // Use granular selectors for history to minimize re-renders
  const toggleFavorite = useHistoryStore((state) => state.toggleFavorite);
  const getHistoryById = useHistoryStore((state) => state.getHistoryById);
  const favorites = useHistoryStore(useShallow(selectFavoriteIds));
  const totalHistoryCount = useHistoryStore(selectHistoryCount);

  // Tabs are read at event time via getState() (see handleOpenCollectionItem)
  // — subscribing here would re-render the whole sidebar on every tab change.
  const openTab = useRequestStore((s) => s.openTab);
  const switchTab = useRequestStore((s) => s.switchTab);
  const [activeTab, setActiveTab] = useState<string>(activePanel ?? 'collections');

  // Sync when activePanel prop changes
  useEffect(() => {
    if (activePanel) {
      setActiveTab(activePanel);
    }
  }, [activePanel]);

  // Tabs visited this mount. Radix unmounts inactive TabsContent, so the
  // Stagger lists remount (and would replay their entrance) on every tab
  // switch — the cascade should only play the first time a tab is shown.
  // Stagger spreads props after its own initial="hidden", so passing
  // initial={false} on revisits renders the list already settled.
  const visitedTabsRef = useRef<Set<string>>(new Set());
  const staggerInitial = visitedTabsRef.current.has(activeTab) ? false : 'hidden';
  useEffect(() => {
    visitedTabsRef.current.add(activeTab);
  }, [activeTab]);
  const commands = useCollectionSidebarCommands();
  const mockStatus = useMockStore((state) => state.status);
  const [searchQuery, setSearchQuery] = useState('');
  const [methodFilter, setMethodFilter] = useState<string | null>(null);
  const [visibleHistoryCount, setVisibleHistoryCount] = useState(HISTORY_PAGE_SIZE);
  const [selectedWorkflow, setSelectedWorkflow] = useState<OwsStoredWorkflow | null>(null);
  const [runningWorkflow, setRunningWorkflow] = useState<OwsStoredWorkflow | null>(null);

  // Item-delete confirmation — one or many (multi-select bulk delete).
  const [itemToDelete, setItemToDelete] = useState<{
    collectionId: string;
    itemIds: string[];
  } | null>(null);

  // Drag-and-drop: the item being dragged + the row currently hovered (for highlight).
  const dragItemRef = useRef<{ collectionId: string; itemId: string } | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  // Collapsed folder ids (session-local; collections default to expanded).
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());

  // Collapsed collection ids (session-local, same lifecycle as collapsedFolders).
  const [collapsedCollections, setCollapsedCollections] = useState<Set<string>>(new Set());

  const toggleCollectionCollapse = useCallback((collectionId: string) => {
    setCollapsedCollections((prev) => toggledSet(prev, collectionId));
  }, []);

  // Collapsed per-collection workflow groups in the Workflows tab (session-local).
  const [collapsedWorkflowGroups, setCollapsedWorkflowGroups] = useState<Set<string>>(new Set());

  const toggleWorkflowGroup = useCallback((collectionId: string) => {
    setCollapsedWorkflowGroups((prev) => toggledSet(prev, collectionId));
  }, []);

  const expandCollection = useCallback((collectionId: string) => {
    setCollapsedCollections((prev) => {
      if (!prev.has(collectionId)) return prev;
      const next = new Set(prev);
      next.delete(collectionId);
      return next;
    });
  }, []);

  /**
   * Expand the collection AND the folder chain down to `parentId`, so a
   * freshly-added item (and its inline rename input) is actually visible
   * even when it lands inside a collapsed folder.
   */
  const revealLocation = useCallback(
    (collectionId: string, parentId?: string) => {
      expandCollection(collectionId);
      if (!parentId) return;
      const collection = getCollectionById(collectionId);
      if (!collection) return;
      const chain = folderPathTo(collection.items, parentId);
      setCollapsedFolders((prev) => {
        if (!chain.some((id) => prev.has(id))) return prev;
        const next = new Set(prev);
        for (const id of chain) next.delete(id);
        return next;
      });
    },
    [expandCollection]
  );

  // Multi-select: `${collectionId}:${itemId}` keys, toggled by cmd/ctrl-click.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const selectedKeysRef = useRef(selectedKeys);
  selectedKeysRef.current = selectedKeys;

  // File collection state
  const conflicts = useFileCollectionStore((state) => state.conflicts);
  const isFileCollection = useFileCollectionStore((state) => state.isFileCollection);
  const activeConflict = conflicts.length > 0 ? conflicts[0] : null;

  // Get visible history items using selector
  const visibleHistory = useHistoryStore(
    useShallow((state) => state.history.slice(0, visibleHistoryCount))
  );

  // Per-collection workflow counts for the Workflows tab group headers.
  const workflowCounts = useWorkflowStore(
    useShallow((state) => {
      const counts: Record<string, number> = {};
      for (const w of state.workflows) {
        counts[w.collectionId] = (counts[w.collectionId] ?? 0) + 1;
      }
      return counts;
    })
  );

  // Filter collections based on search query
  const filteredCollections = useMemo(() => {
    if (!searchQuery) return collections;
    const query = searchQuery.toLowerCase();
    return collections.filter(
      (c) =>
        c.name.toLowerCase().includes(query) ||
        c.items.some((item) => item.name.toLowerCase().includes(query))
    );
  }, [collections, searchQuery]);

  // Filter history based on search query and method filter
  const filteredHistory = useMemo(() => {
    let filtered = visibleHistory;

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((item) => {
        const r = item.request;
        if (r.type === 'http') {
          return r.url.toLowerCase().includes(query) || r.method.toLowerCase().includes(query);
        }
        if (r.type === 'grpc') {
          return (
            r.service?.toLowerCase().includes(query) || r.method?.toLowerCase().includes(query)
          );
        }
        // sse / mcp — match on URL only
        return r.url.toLowerCase().includes(query);
      });
    }

    if (methodFilter) {
      filtered = filtered.filter((item) => {
        if (item.request.type === 'http') {
          return item.request.method === methodFilter;
        }
        return false;
      });
    }

    return filtered;
  }, [visibleHistory, searchQuery, methodFilter]);

  const hasMoreHistory = visibleHistoryCount < totalHistoryCount;

  const handleLoadMore = useCallback(() => {
    setVisibleHistoryCount((prev) => prev + HISTORY_PAGE_SIZE);
  }, []);

  const handleLoadHistoryItem = useCallback(
    (itemId: string) => {
      const item = getHistoryById(itemId);
      if (!item) return;
      // Focus an existing tab linked to this saved request, otherwise open a new tab.
      // History items aren't saved requests themselves, so we always open a fresh tab.
      const existing = useRequestStore
        .getState()
        .tabs.find((t) => t.savedRequestId === item.request.id);
      if (existing) {
        switchTab(existing.id);
        return;
      }
      openTab(item.request, { savedRequestId: item.request.id });
    },
    [getHistoryById, openTab, switchTab]
  );

  const handleOpenCollectionItem = useCallback(
    (item: CollectionItem) => {
      if (item.type !== 'request' || !item.request) return;
      const existing = useRequestStore.getState().tabs.find((t) => t.savedRequestId === item.id);
      if (existing) {
        switchTab(existing.id);
        return;
      }
      openTab(item.request, { savedRequestId: item.id });
    },
    [openTab, switchTab]
  );

  const handleAddFolder = useCallback(
    (collectionId: string, parentId?: string) => {
      const folder = makeFolderItem(uniqueName('New Folder', siblingNames(collectionId, parentId)));
      addItemToCollection(collectionId, folder, parentId);
      // Make sure the new folder is visible for the inline rename.
      revealLocation(collectionId, parentId);
      commands.startItemRename(folder.id, folder.name);
    },
    [addItemToCollection, revealLocation, commands.startItemRename]
  );

  const handleAddRequest = useCallback(
    (collectionId: string, parentId?: string) => {
      const item = makeRequestItem(uniqueName('New Request', siblingNames(collectionId, parentId)));
      addItemToCollection(collectionId, item, parentId);
      revealLocation(collectionId, parentId);
      // Land the user in the builder for the new saved request.
      if (item.request) openTab(item.request, { savedRequestId: item.id, switchTo: true });
    },
    [addItemToCollection, revealLocation, openTab]
  );

  const handleDuplicateItem = useCallback(
    (collectionId: string, item: CollectionItem) => {
      // Land the duplicate next to the original, not at the collection root.
      const collection = getCollectionById(collectionId);
      const parentId = collection ? parentFolderIdOf(collection.items, item.id) : undefined;
      const dup = duplicateRequestItem(item, siblingNames(collectionId, parentId));
      addItemToCollection(collectionId, dup, parentId);
    },
    [addItemToCollection]
  );

  const handleConfirmItemDelete = useCallback(() => {
    if (itemToDelete) {
      for (const itemId of itemToDelete.itemIds) {
        removeCollectionItem(itemToDelete.collectionId, itemId);
      }
      setSelectedKeys((prev) => (prev.size === 0 ? prev : new Set()));
      setItemToDelete(null);
    }
  }, [itemToDelete, removeCollectionItem]);

  // --- Tree state: collapse + multi-select -----------------------------------
  const toggleCollapse = useCallback((folderId: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);

  const toggleSelect = useCallback((collectionId: string, itemId: string) => {
    setSelectedKeys((prev) => {
      const key = selectionKey(collectionId, itemId);
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedKeys((prev) => (prev.size === 0 ? prev : new Set()));
  }, []);

  const handleDeleteSelected = useCallback((collectionId: string) => {
    // Read via ref so this callback (and the actions bundle) stays stable
    // across selection changes.
    const prefix = `${collectionId}:`;
    const itemIds = [...selectedKeysRef.current]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
    if (itemIds.length > 0) setItemToDelete({ collectionId, itemIds });
  }, []);

  // --- Drag and drop ---------------------------------------------------------
  const handleItemDragStart = useCallback(
    (e: React.DragEvent, collectionId: string, itemId: string) => {
      dragItemRef.current = { collectionId, itemId };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', itemId);
    },
    []
  );

  const handleItemDragEnd = useCallback(() => {
    dragItemRef.current = null;
    setDropTargetId(null);
  }, []);

  /**
   * Shared guard + move for all drop/move paths: refuse a move that would
   * land the item next to a same-named sibling (same-level reorders pass).
   */
  const guardedMove = useCallback(
    (collectionId: string, itemId: string, target: { parentId?: string; beforeId?: string }) => {
      const collection = getCollectionById(collectionId);
      if (collection && moveWouldCollide(collection, itemId, target)) {
        toast.error('An item with this name already exists there');
        return;
      }
      moveCollectionItem(collectionId, itemId, target);
    },
    [moveCollectionItem]
  );

  /** Drop onto a folder row → move the dragged item *into* that folder. */
  const handleDropIntoFolder = useCallback(
    (e: React.DragEvent, collectionId: string, folderId: string) => {
      e.preventDefault();
      e.stopPropagation();
      const drag = dragItemRef.current;
      setDropTargetId(null);
      if (!drag || drag.collectionId !== collectionId || drag.itemId === folderId) return;
      guardedMove(collectionId, drag.itemId, { parentId: folderId });
    },
    [guardedMove]
  );

  /** Drop onto a request row → place the dragged item before it, in that row's parent folder. */
  const handleDropBeforeItem = useCallback(
    (e: React.DragEvent, collectionId: string, beforeId: string) => {
      e.preventDefault();
      e.stopPropagation();
      const drag = dragItemRef.current;
      setDropTargetId(null);
      if (!drag || drag.collectionId !== collectionId || drag.itemId === beforeId) return;
      guardedMove(collectionId, drag.itemId, { beforeId });
    },
    [guardedMove]
  );

  /** Drop onto the collection root strip → move the dragged item to the root. */
  const handleDropToRoot = useCallback(
    (e: React.DragEvent, collectionId: string) => {
      e.preventDefault();
      const drag = dragItemRef.current;
      setDropTargetId(null);
      if (!drag || drag.collectionId !== collectionId) return;
      guardedMove(collectionId, drag.itemId, {});
    },
    [guardedMove]
  );

  const handleMoveToFolder = useCallback(
    (collectionId: string, itemId: string, folderId: string) => {
      guardedMove(collectionId, itemId, { parentId: folderId });
    },
    [guardedMove]
  );

  // Stable callback bundle for the memoized tree rows. Everything in here is
  // a stable useCallback (selection reads go through refs), so the bundle's
  // identity never changes and row memoization holds.
  const treeActions: TreeActions = useMemo(
    () => ({
      openItem: handleOpenCollectionItem,
      addRequest: handleAddRequest,
      addFolder: handleAddFolder,
      duplicateItem: handleDuplicateItem,
      deleteItem: (collectionId: string, itemId: string) =>
        setItemToDelete({ collectionId, itemIds: [itemId] }),
      deleteSelected: handleDeleteSelected,
      runFolder: (collectionId: string, folderId: string) =>
        commands.setRunnerScope({ collectionId, folderId }),
      openFolderSettings: (collectionId: string, item: CollectionItem) =>
        commands.setSettingsTarget({ scope: 'folder', collectionId, item }),
      startRename: commands.startItemRename,
      commitRename: commands.commitItemRename,
      cancelRename: () => commands.setRenamingItemId(null),
      setRenameValue: commands.setItemRenameValue,
      renameInputRef: commands.itemRenameRef,
      toggleCollapse,
      toggleSelect,
      clearSelection,
      dragStart: handleItemDragStart,
      dragEnd: handleItemDragEnd,
      setDropTarget: setDropTargetId,
      dropIntoFolder: handleDropIntoFolder,
      dropBeforeItem: handleDropBeforeItem,
      moveToFolder: handleMoveToFolder,
    }),
    [
      handleOpenCollectionItem,
      handleAddRequest,
      handleAddFolder,
      handleDuplicateItem,
      handleDeleteSelected,
      commands.startItemRename,
      commands.commitItemRename,
      toggleCollapse,
      toggleSelect,
      clearSelection,
      handleItemDragStart,
      handleItemDragEnd,
      handleDropIntoFolder,
      handleDropBeforeItem,
      handleMoveToFolder,
    ]
  );

  // Search forces every collapse level open so matches stay visible.
  const effectiveCollapsedFolders = searchQuery ? EMPTY_COLLAPSED : collapsedFolders;
  const effectiveCollapsedCollections = searchQuery ? EMPTY_COLLAPSED : collapsedCollections;
  const effectiveCollapsedWorkflowGroups = searchQuery ? EMPTY_COLLAPSED : collapsedWorkflowGroups;

  // Volatile tree state, fanned out to per-row booleans inside the tree.
  const treeState: TreeState = {
    renamingItemId: commands.renamingItemId,
    renameValue: commands.itemRenameValue,
    dropTargetId,
    collapsedFolders: effectiveCollapsedFolders,
    selectedKeys,
  };

  return (
    <TooltipProvider delayDuration={300}>
      <aside
        aria-label="Collections, history, and workflows"
        className="sp-chrome flex flex-col h-full"
      >
        {/* Search Input */}
        <Input
          className="h-7 bg-transparent border-0 border-b border-border rounded-none px-3 text-xs placeholder:text-sp-dim focus-visible:shadow-none focus-visible:border-primary"
          placeholder="Search..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />

        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex-1 flex flex-col overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-border/40">
            {/* Icon tabs — four text labels crowd the 268px rail, so the row is
                icon-only with tooltips; the panel header above names the active
                one. */}
            <TabsList className="w-full grid grid-cols-4">
              <TabsTrigger
                value="collections"
                aria-label="Collections"
                title="Collections"
                className="relative"
              >
                <Folder className="h-4 w-4" />
                {filteredCollections.length > 0 && (
                  <span className="absolute -top-0.5 right-1 text-[8px] leading-none bg-primary/15 text-primary px-1 py-0.5 rounded-full tabular-nums font-bold">
                    {filteredCollections.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="history" aria-label="History" title="History">
                <History className="h-4 w-4" />
              </TabsTrigger>
              <TabsTrigger value="workflows" aria-label="Workflows" title="Workflows">
                <WorkflowIcon className="h-4 w-4" />
              </TabsTrigger>
              <TabsTrigger value="runs" aria-label="Runs" title="Runs">
                <Activity className="h-4 w-4" />
              </TabsTrigger>
            </TabsList>
          </div>

          <SidebarCollectionsPanel
            collections={filteredCollections}
            collapsedCollections={effectiveCollapsedCollections}
            collapsedFolders={effectiveCollapsedFolders}
            dropTargetId={dropTargetId}
            hasDraggedItem={() => dragItemRef.current !== null}
            isElectron={isElectronEnvironment()}
            isFileCollection={isFileCollection}
            mockStatus={mockStatus}
            renamingCollectionId={commands.renamingCollectionId}
            collectionRenameValue={commands.collectionRenameValue}
            collectionRenameRef={commands.collectionRenameRef}
            searchQuery={searchQuery}
            staggerInitial={staggerInitial}
            treeActions={treeActions}
            treeState={treeState}
            onAddFolder={handleAddFolder}
            onAddRequest={handleAddRequest}
            onCloneWorkspace={() => commands.openDirectoryPicker('clone')}
            onCollectionDragOver={(collectionId) => {
              if (dragItemRef.current) expandCollection(collectionId);
            }}
            onConfirmCollectionRename={commands.commitCollectionRename}
            onDeleteCollection={(collectionId) => {
              commands.setCollectionToDelete(collectionId);
              commands.setDeleteDialogOpen(true);
            }}
            onDropToRoot={handleDropToRoot}
            onDuplicateCollection={commands.handleDuplicateCollection}
            onExportCollection={commands.handleExportCollection}
            onGit={commands.handleOpenGit}
            onOpenFromFolder={() => commands.openDirectoryPicker('open')}
            onOpenInExplorer={commands.openCollectionInExplorer}
            onOpenSettings={(collection) =>
              commands.setSettingsTarget({ scope: 'collection', collection })
            }
            onOpenDocs={commands.setDocsCollection}
            onRunCollection={(collectionId) => commands.setRunnerScope({ collectionId })}
            onSaveToFiles={(collectionId) => commands.openDirectoryPicker('save', collectionId)}
            onSetCollectionRenameValue={commands.setCollectionRenameValue}
            onStartCollectionRename={commands.startCollectionRename}
            onSyncCollection={commands.handleSyncCollection}
            onToggleCollectionCollapse={toggleCollectionCollapse}
            onToggleMock={commands.handleToggleMock}
            onNewCollection={commands.handleNewCollection}
            onCancelCollectionRename={() => commands.setRenamingCollectionId(null)}
            onSetDropTarget={setDropTargetId}
          />
          <ConfirmDialog
            open={commands.deleteDialogOpen}
            onOpenChange={commands.setDeleteDialogOpen}
            title="Delete Collection"
            description="Are you sure you want to delete this collection? This action cannot be undone."
            confirmText="Delete"
            cancelText="Cancel"
            onConfirm={commands.handleConfirmDelete}
            variant="destructive"
          />

          <SidebarHistoryPanel
            filteredHistory={filteredHistory}
            favorites={favorites}
            hasMoreHistory={hasMoreHistory}
            methodFilter={methodFilter}
            searchQuery={searchQuery}
            staggerInitial={staggerInitial}
            totalHistoryCount={totalHistoryCount}
            visibleHistoryCount={visibleHistoryCount}
            onLoadHistoryItem={handleLoadHistoryItem}
            onLoadMore={handleLoadMore}
            onMethodFilterChange={setMethodFilter}
            onToggleFavorite={toggleFavorite}
          />

          <SidebarWorkflowsPanel
            collections={filteredCollections}
            collapsedGroups={effectiveCollapsedWorkflowGroups}
            workflowCounts={workflowCounts}
            onRunWorkflow={setRunningWorkflow}
            onSelectWorkflow={setSelectedWorkflow}
            onToggleGroup={toggleWorkflowGroup}
          />

          <TabsContent value="runs" className="flex-1 overflow-auto p-3 mt-0 min-h-0">
            <RunsPanel />
          </TabsContent>
        </Tabs>

        {/* Workflow Builder Dialog */}
        {selectedWorkflow && (
          <WorkflowBuilder
            workflow={selectedWorkflow}
            open={!!selectedWorkflow}
            onOpenChange={(open) => !open && setSelectedWorkflow(null)}
            onRun={() => {
              setRunningWorkflow(
                useWorkflowStore.getState().getWorkflowById(selectedWorkflow.id) ?? selectedWorkflow
              );
              setSelectedWorkflow(null);
            }}
          />
        )}
        {/* Workflow Executor Dialog */}
        {runningWorkflow && (
          <WorkflowExecutor
            workflow={runningWorkflow}
            open={!!runningWorkflow}
            onOpenChange={(open) => !open && setRunningWorkflow(null)}
          />
        )}
        {/* File Collection Dialogs */}
        <CollectionDirectoryPicker
          open={commands.directoryPickerOpen}
          onOpenChange={commands.setDirectoryPickerOpen}
          mode={commands.directoryPickerMode}
          collectionId={commands.saveCollectionId}
        />
        <ConflictDialog
          conflict={activeConflict ?? null}
          onClose={() => {
            if (activeConflict) {
              useFileCollectionStore
                .getState()
                .removeConflict(activeConflict.collectionId, activeConflict.itemId);
            }
          }}
        />

        <ConfirmDialog
          open={itemToDelete !== null}
          onOpenChange={(open) => {
            if (!open) setItemToDelete(null);
          }}
          title={
            itemToDelete && itemToDelete.itemIds.length > 1
              ? `Delete ${itemToDelete.itemIds.length} items`
              : 'Delete item'
          }
          description={
            itemToDelete && itemToDelete.itemIds.length > 1
              ? `Delete ${itemToDelete.itemIds.length} selected items and everything inside them? This action cannot be undone.`
              : 'Delete this item and everything inside it? This action cannot be undone.'
          }
          confirmText="Delete"
          cancelText="Cancel"
          onConfirm={handleConfirmItemDelete}
          variant="destructive"
        />
      </aside>

      {commands.runnerScope && (
        <CollectionRunnerDialog
          scope={commands.runnerScope}
          onClose={() => commands.setRunnerScope(null)}
        />
      )}

      {commands.settingsTarget && (
        <CollectionSettingsDialog
          target={commands.settingsTarget}
          onClose={() => commands.setSettingsTarget(null)}
        />
      )}

      {commands.exportPrompt && (
        <ExportSecretsDialog
          open
          secretCount={commands.exportPrompt.secretCount}
          onCancel={() => commands.setExportPrompt(null)}
          onExport={(includeSecrets) => {
            const prompt = commands.exportPrompt;
            if (!prompt) return;
            const { collection, format } = prompt;
            commands.setExportPrompt(null);
            void commands.performExport(
              includeSecrets ? collection : redactCollectionSecrets(collection),
              format
            );
          }}
        />
      )}

      {commands.docsCollection && (
        <DocsViewer
          collection={commands.docsCollection}
          onClose={() => commands.setDocsCollection(null)}
        />
      )}

      {commands.gitTarget && (
        <GitDialog
          open
          collectionName={commands.gitTarget.collection.name}
          directoryPath={commands.gitTarget.directoryPath}
          onClose={() => commands.setGitTarget(null)}
        />
      )}
    </TooltipProvider>
  );
}

export default withErrorBoundary(Sidebar);
