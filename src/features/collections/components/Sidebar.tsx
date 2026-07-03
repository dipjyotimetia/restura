import {
  FolderPlus,
  History,
  Star,
  X,
  MoreVertical,
  Download,
  Trash2,
  GitBranch,
  FolderOpen,
  HardDrive,
  Pencil,
  FileText,
  Play,
  Square,
  Folder,
  FilePlus,
  Copy,
  Settings2,
  Workflow as WorkflowIcon,
  Activity,
} from 'lucide-react';
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import {
  makeFolderItem,
  makeRequestItem,
  duplicateRequestItem,
  duplicateCollection,
} from '../lib/itemFactory';
import { buildMockRoutes, buildMockRoutesFromSpec, mergeMockRoutes } from '../lib/mockRoutes';
import { CollectionDirectoryPicker } from './CollectionDirectoryPicker';
import { CollectionRunnerDialog, type RunnerScope } from './CollectionRunnerDialog';
import { CollectionSettingsDialog, type SettingsTarget } from './CollectionSettingsDialog';
import {
  CollectionTreeItems,
  handleTreeKeyDown,
  selectionKey,
  type TreeActions,
  type TreeState,
} from './CollectionTree';
import { ConflictDialog } from './ConflictDialog';
import DocsViewer from './DocsViewer';
import { ExportSecretsDialog } from './ExportSecretsDialog';
import { FileStatusBadge } from './FileStatusBadge';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import GitDialog from '@/components/shared/GitDialog';
import RunsPanel from '@/components/shared/RunsPanel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Stagger, StaggerItem } from '@/components/ui/motion';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  exportToPostman,
  exportToInsomnia,
  exportToOpenCollection,
  downloadJSON,
  downloadText,
} from '@/features/collections/lib/exporters';
import { loadContractSpec } from '@/features/contracts/lib/specLoader';
import { WorkflowBuilder } from '@/features/workflows/components/WorkflowBuilder';
import { WorkflowExecutor } from '@/features/workflows/components/WorkflowExecutor';
import { WorkflowManager } from '@/features/workflows/components/WorkflowManager';
import {
  redactCollectionSecrets,
  countCollectionInlineSecrets,
} from '@/lib/shared/collection-secret-redaction';
import { httpLikeStatus } from '@/lib/shared/console-format';
import { METHOD_COLORS, PROTOCOL_LABELS } from '@/lib/shared/constants';
import { downloadBlob } from '@/lib/shared/file-utils';
import { getElectronAPI } from '@/lib/shared/platform';
import { cn } from '@/lib/shared/utils';
import { selectFavoriteIds, selectHistoryCount } from '@/store/selectors';
import { useCollectionStore } from '@/store/useCollectionStore';
import {
  useFileCollectionStore,
  isElectronEnvironment,
  openCollectionInExplorer,
  syncFileCollection,
} from '@/store/useFileCollectionStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useMockStore } from '@/store/useMockStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import type { ActivePanel, Collection, CollectionItem, OpenAPIDocument, Workflow } from '@/types';

interface SidebarProps {
  onClose: () => void;
  activePanel?: ActivePanel | null;
}

const HISTORY_PAGE_SIZE = 20;

type ExportFormat = 'postman' | 'insomnia' | 'opencollection' | 'bruno';

function Sidebar({ onClose, activePanel }: SidebarProps) {
  const {
    collections,
    createNewCollection,
    addCollection,
    removeCollection,
    updateCollection,
    updateCollectionItem,
    addItemToCollection,
    removeCollectionItem,
    moveCollectionItem,
  } = useCollectionStore(
    useShallow((s) => ({
      collections: s.collections,
      createNewCollection: s.createNewCollection,
      addCollection: s.addCollection,
      removeCollection: s.removeCollection,
      updateCollection: s.updateCollection,
      updateCollectionItem: s.updateCollectionItem,
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
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [collectionToDelete, setCollectionToDelete] = useState<string | null>(null);
  const [settingsTarget, setSettingsTarget] = useState<SettingsTarget | null>(null);
  const [docsCollection, setDocsCollection] = useState<Collection | null>(null);
  const [gitTarget, setGitTarget] = useState<{
    collection: Collection;
    directoryPath: string;
  } | null>(null);
  // Export held pending the include-vs-redact secrets choice.
  const [exportPrompt, setExportPrompt] = useState<{
    collection: Collection;
    format: ExportFormat;
    secretCount: number;
  } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [methodFilter, setMethodFilter] = useState<string | null>(null);
  const [visibleHistoryCount, setVisibleHistoryCount] = useState(HISTORY_PAGE_SIZE);
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null);
  const [runningWorkflow, setRunningWorkflow] = useState<Workflow | null>(null);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [directoryPickerMode, setDirectoryPickerMode] = useState<'open' | 'save'>('open');
  const [saveCollectionId, setSaveCollectionId] = useState<string | undefined>();

  // Inline rename state for collections
  const [renamingCollectionId, setRenamingCollectionId] = useState<string | null>(null);
  const [collectionRenameValue, setCollectionRenameValue] = useState('');
  const collectionRenameRef = useRef<HTMLInputElement>(null);
  const collectionRenameValueRef = useRef(collectionRenameValue);
  collectionRenameValueRef.current = collectionRenameValue;

  // Inline rename state for collection items
  const [renamingItemId, setRenamingItemId] = useState<string | null>(null);
  const [itemRenameValue, setItemRenameValue] = useState('');
  const itemRenameRef = useRef<HTMLInputElement>(null);
  const itemRenameValueRef = useRef(itemRenameValue);
  itemRenameValueRef.current = itemRenameValue;

  // Collection / folder runner dialog scope (null = closed).
  const [runnerScope, setRunnerScope] = useState<RunnerScope | null>(null);

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

  // Multi-select: `${collectionId}:${itemId}` keys, toggled by cmd/ctrl-click.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const selectedKeysRef = useRef(selectedKeys);
  selectedKeysRef.current = selectedKeys;

  // File collection state
  const conflicts = useFileCollectionStore((state) => state.conflicts);
  const isFileCollection = useFileCollectionStore((state) => state.isFileCollection);
  const unregisterFileCollection = useFileCollectionStore(
    (state) => state.unregisterFileCollection
  );
  const activeConflict = conflicts.length > 0 ? conflicts[0] : null;

  // Get visible history items using selector
  const visibleHistory = useHistoryStore(
    useShallow((state) => state.history.slice(0, visibleHistoryCount))
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

  const startCollectionRename = useCallback((id: string, currentName: string) => {
    setRenamingCollectionId(id);
    setCollectionRenameValue(currentName);
    // Double-setTimeout to outlast Radix DropdownMenu's FocusScope cleanup,
    // which uses setTimeout(fn, 0) to return focus to the trigger.
    setTimeout(() => setTimeout(() => collectionRenameRef.current?.select(), 0), 0);
  }, []);

  const handleNewCollection = useCallback(() => {
    // Generate unique name with auto-increment
    const existingNames = collections.map((c) => c.name);
    let name = 'New Collection';
    let counter = 1;
    while (existingNames.includes(name)) {
      counter++;
      name = `New Collection ${counter}`;
    }
    const newCollection = createNewCollection(name);
    addCollection(newCollection);
    startCollectionRename(newCollection.id, newCollection.name);
  }, [collections, createNewCollection, addCollection, startCollectionRename]);

  // None of Postman/Insomnia/OpenCollection/Bruno have a DAG/graph concept,
  // so a linked workflow isn't "flattened" on export — it's silently
  // omitted entirely, which reads as "covered everything" when it didn't.
  // Warn (matching the Bruno lossy-export pattern below) rather than stay
  // silent.
  const warnAboutOmittedWorkflows = useCallback((collection: Collection) => {
    const linked = useWorkflowStore
      .getState()
      .workflows.filter((w) => w.collectionId === collection.id);
    if (linked.length === 0) return;
    toast.warning(
      `This export format doesn't support Flow workflows — ${linked.length} workflow${
        linked.length === 1 ? '' : 's'
      } in "${collection.name}" ${linked.length === 1 ? 'was' : 'were'} not included.`
    );
  }, []);

  const performExport = useCallback(
    async (collection: Collection, format: ExportFormat) => {
      if (format === 'postman') {
        const postmanData = exportToPostman(collection);
        downloadJSON(postmanData, `${collection.name}.postman_collection.json`);
        warnAboutOmittedWorkflows(collection);
      } else if (format === 'insomnia') {
        const insomniaData = exportToInsomnia(collection);
        downloadJSON(insomniaData, `${collection.name}.insomnia.json`);
        warnAboutOmittedWorkflows(collection);
      } else if (format === 'bruno') {
        // Lazy import — keeps @usebruno/lang out of the main bundle.
        const { exportBrunoCollection } = await import('../lib/bruno-exporter');
        const exported = await exportBrunoCollection(collection);
        if (exported.kind !== 'directory') return;

        const api = getElectronAPI();
        if (api?.collections) {
          const dirResult = await api.collections.selectDirectory();
          if (dirResult.canceled || !dirResult.filePaths?.[0]) return;
          const saveResult = await api.collections.saveBrunoToDirectory(
            exported.entries,
            dirResult.filePaths[0]
          );
          if (!saveResult.success) {
            toast.error(saveResult.error ?? 'Bruno export failed');
            return;
          }
          toast.success(`Exported ${exported.entries.length} files to ${dirResult.filePaths[0]}`);
        } else {
          const { zipEntries } = await import('@/lib/shared/zip-utils');
          const blob = await zipEntries(exported.entries);
          downloadBlob(blob, `${collection.name}.bruno.zip`, 'application/zip');
        }

        // Surface lossy-export warnings so users discover non-HTTP downgrades
        // at export time rather than later when Bruno fails to run the request.
        if (exported.warnings.length > 0) {
          const first = exported.warnings[0]!;
          const extra =
            exported.warnings.length > 1 ? ` (+${exported.warnings.length - 1} more)` : '';
          toast.warning(`Bruno export: ${first.message}${extra}`);
        }
        warnAboutOmittedWorkflows(collection);
      } else {
        const yamlText = exportToOpenCollection(collection);
        downloadText(yamlText, `${collection.name}.opencollection.yaml`, 'application/x-yaml');
        warnAboutOmittedWorkflows(collection);
      }
    },
    [warnAboutOmittedWorkflows]
  );

  const handleExportCollection = useCallback(
    async (collectionId: string, format: ExportFormat) => {
      const collection = collections.find((c) => c.id === collectionId);
      if (!collection) return;
      // Plaintext secrets need an explicit include-vs-redact choice before
      // they land in a shareable file. Handle-based secrets are always safe.
      const secretCount = countCollectionInlineSecrets(collection);
      if (secretCount > 0) {
        setExportPrompt({ collection, format, secretCount });
        return;
      }
      await performExport(collection, format);
    },
    [collections, performExport]
  );

  const handleDuplicateCollection = useCallback(
    (collectionId: string) => {
      const collection = collections.find((c) => c.id === collectionId);
      if (!collection) return;
      addCollection(duplicateCollection(collection));
    },
    [collections, addCollection]
  );

  const mockStatus = useMockStore((s) => s.status);
  const setMockStatus = useMockStore((s) => s.setStatus);
  const setMockRoutes = useMockStore((s) => s.setRoutes);

  const handleToggleMock = useCallback(
    async (collectionId: string) => {
      const api = getElectronAPI();
      if (!api?.mock) {
        toast.error('Mock server is only available in the desktop app');
        return;
      }
      const isRunningHere = mockStatus.running && mockStatus.collectionId === collectionId;
      if (isRunningHere) {
        const res = await api.mock.stop();
        if (res.ok) {
          setMockStatus(res.status);
          setMockRoutes([]);
          toast.success('Mock server stopped');
        } else {
          toast.error(`Failed to stop mock server: ${res.error}`);
        }
        return;
      }
      const collection = collections.find((c) => c.id === collectionId);
      if (!collection) return;
      const historyRoutes = buildMockRoutes(collection, useHistoryStore.getState().history);

      let specRouteCount = 0;
      let routes = historyRoutes;
      if (collection.contractSpec) {
        const loaded = await loadContractSpec(collection.contractSpec);
        if (loaded.ok) {
          const specRoutes = buildMockRoutesFromSpec(loaded.spec as unknown as OpenAPIDocument);
          routes = mergeMockRoutes(historyRoutes, specRoutes);
          specRouteCount = routes.length - historyRoutes.length;
        } else {
          toast.warning(`Attached OpenAPI spec failed to load: ${loaded.error}`);
        }
      }

      if (routes.length === 0) {
        toast.warning('No HTTP requests or OpenAPI spec to mock in this collection');
        return;
      }
      const res = await api.mock.start({ collectionId, routes });
      if (res.ok) {
        setMockStatus(res.status);
        // Surface the served routes in the Runs panel.
        setMockRoutes(routes.map((r) => ({ method: r.method, path: r.path })));
        const description =
          specRouteCount > 0
            ? `${historyRoutes.length} from history · ${specRouteCount} from spec`
            : `${res.status.routeCount} route${res.status.routeCount === 1 ? '' : 's'} · replays recorded responses`;
        toast.success(`Mock server running at ${res.status.baseUrl}`, { description });
      } else {
        toast.error(`Failed to start mock server: ${res.error}`);
      }
    },
    [collections, mockStatus, setMockStatus, setMockRoutes]
  );

  const handleDeleteClick = useCallback((collectionId: string) => {
    setCollectionToDelete(collectionId);
    setDeleteDialogOpen(true);
  }, []);

  const handleConfirmDelete = useCallback(() => {
    if (collectionToDelete) {
      // Unregister from file collection store if needed
      if (isFileCollection(collectionToDelete)) {
        unregisterFileCollection(collectionToDelete);
      }
      removeCollection(collectionToDelete);
      setCollectionToDelete(null);
    }
    setDeleteDialogOpen(false);
  }, [collectionToDelete, removeCollection, isFileCollection, unregisterFileCollection]);

  const handleOpenFromFolder = useCallback(() => {
    setDirectoryPickerMode('open');
    setSaveCollectionId(undefined);
    setDirectoryPickerOpen(true);
  }, []);

  const handleSaveToFiles = useCallback((collectionId: string) => {
    setDirectoryPickerMode('save');
    setSaveCollectionId(collectionId);
    setDirectoryPickerOpen(true);
  }, []);

  const handleOpenInExplorer = useCallback((collectionId: string) => {
    openCollectionInExplorer(collectionId);
  }, []);

  const handleSyncCollection = useCallback(async (collectionId: string) => {
    await syncFileCollection(collectionId);
  }, []);

  const commitCollectionRename = useCallback(() => {
    if (renamingCollectionId && collectionRenameValueRef.current.trim()) {
      updateCollection(renamingCollectionId, { name: collectionRenameValueRef.current.trim() });
    }
    setRenamingCollectionId(null);
  }, [renamingCollectionId, updateCollection]);

  const startItemRename = useCallback((itemId: string, currentName: string) => {
    setRenamingItemId(itemId);
    setItemRenameValue(currentName);
    // Double-setTimeout so our focus grab fires after Radix DropdownMenu's
    // FocusScope cleanup, which also uses setTimeout(fn, 0) to return focus
    // to the trigger and would otherwise steal focus from the rename input.
    setTimeout(() => setTimeout(() => itemRenameRef.current?.select(), 0), 0);
  }, []);

  const commitItemRename = useCallback(
    (collectionId: string, itemId: string) => {
      if (itemRenameValueRef.current.trim()) {
        updateCollectionItem(collectionId, itemId, { name: itemRenameValueRef.current.trim() });
      }
      setRenamingItemId(null);
    },
    [updateCollectionItem]
  );

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
      const folder = makeFolderItem();
      addItemToCollection(collectionId, folder, parentId);
      startItemRename(folder.id, folder.name);
    },
    [addItemToCollection, startItemRename]
  );

  const handleAddRequest = useCallback(
    (collectionId: string, parentId?: string) => {
      const item = makeRequestItem();
      addItemToCollection(collectionId, item, parentId);
      // Land the user in the builder for the new saved request.
      if (item.request) openTab(item.request, { savedRequestId: item.id, switchTo: true });
    },
    [addItemToCollection, openTab]
  );

  const handleDuplicateItem = useCallback(
    (collectionId: string, item: CollectionItem, parentId?: string) => {
      addItemToCollection(collectionId, duplicateRequestItem(item), parentId);
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

  /** Drop onto a folder row → move the dragged item *into* that folder. */
  const handleDropIntoFolder = useCallback(
    (e: React.DragEvent, collectionId: string, folderId: string) => {
      e.preventDefault();
      e.stopPropagation();
      const drag = dragItemRef.current;
      setDropTargetId(null);
      if (!drag || drag.collectionId !== collectionId || drag.itemId === folderId) return;
      moveCollectionItem(collectionId, drag.itemId, { parentId: folderId });
    },
    [moveCollectionItem]
  );

  /** Drop onto a request row → place the dragged item before it, in that row's parent folder. */
  const handleDropBeforeItem = useCallback(
    (e: React.DragEvent, collectionId: string, beforeId: string) => {
      e.preventDefault();
      e.stopPropagation();
      const drag = dragItemRef.current;
      setDropTargetId(null);
      if (!drag || drag.collectionId !== collectionId || drag.itemId === beforeId) return;
      moveCollectionItem(collectionId, drag.itemId, { beforeId });
    },
    [moveCollectionItem]
  );

  /** Drop onto the collection root strip → move the dragged item to the root. */
  const handleDropToRoot = useCallback(
    (e: React.DragEvent, collectionId: string) => {
      e.preventDefault();
      const drag = dragItemRef.current;
      setDropTargetId(null);
      if (!drag || drag.collectionId !== collectionId) return;
      moveCollectionItem(collectionId, drag.itemId, {});
    },
    [moveCollectionItem]
  );

  const handleMoveToFolder = useCallback(
    (collectionId: string, itemId: string, folderId: string) => {
      moveCollectionItem(collectionId, itemId, { parentId: folderId });
    },
    [moveCollectionItem]
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
        setRunnerScope({ collectionId, folderId }),
      openFolderSettings: (collectionId: string, item: CollectionItem) =>
        setSettingsTarget({ scope: 'folder', collectionId, item }),
      startRename: startItemRename,
      commitRename: commitItemRename,
      cancelRename: () => setRenamingItemId(null),
      setRenameValue: setItemRenameValue,
      renameInputRef: itemRenameRef,
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
      startItemRename,
      commitItemRename,
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

  // Volatile tree state, fanned out to per-row booleans inside the tree.
  const treeState: TreeState = {
    renamingItemId,
    renameValue: itemRenameValue,
    dropTargetId,
    collapsedFolders,
    selectedKeys,
  };

  return (
    <TooltipProvider delayDuration={300}>
      <aside
        aria-label="Collections, history, and workflows"
        className="sp-chrome flex flex-col h-full"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-sp-line shrink-0">
          <span className="text-[10px] font-mono font-semibold tracking-widest text-muted-foreground uppercase">
            {activeTab === 'collections'
              ? 'Collections'
              : activeTab === 'history'
                ? 'History'
                : activeTab === 'runs'
                  ? 'Runs'
                  : 'Workflows'}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close panel"
            className="h-6 w-6 text-muted-foreground"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>

        {/* Search Input */}
        <Input
          className="h-7 bg-transparent border-0 border-b border-border rounded-none px-3 text-xs placeholder:text-sp-dim focus-visible:shadow-none focus-visible:border-primary font-mono"
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

          <TabsContent value="collections" className="flex-1 overflow-auto p-3 mt-0 min-h-0">
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <Button
                  onClick={handleNewCollection}
                  variant="outline"
                  size="sm"
                  className="flex-1 justify-start h-8 text-xs border-border hover:border-primary/50 hover:bg-primary/5 dark:hover:bg-primary/10 transition-all duration-200 shadow-sm hover:shadow"
                >
                  <FolderPlus className="mr-2 h-3.5 w-3.5 text-primary" />
                  New
                </Button>
                {isElectronEnvironment() && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        onClick={handleOpenFromFolder}
                        variant="outline"
                        size="sm"
                        className="h-8 px-2.5 border-border hover:border-primary/50 hover:bg-primary/5"
                      >
                        <FolderOpen className="h-3.5 w-3.5 text-primary" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Open from folder</p>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>

              {filteredCollections.length === 0 ? (
                <div className="text-center text-xs py-10 px-3">
                  <div className="mx-auto mb-3 h-12 w-12 rounded-xl bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center">
                    <FolderPlus className="h-6 w-6 text-primary/60" />
                  </div>
                  <p className="font-medium text-foreground">
                    {searchQuery ? 'No collections found' : 'No collections yet'}
                  </p>
                  <p className="text-xs mt-1 text-muted-foreground">
                    {searchQuery
                      ? 'Try a different search term'
                      : 'Create one to organize your requests'}
                  </p>
                </div>
              ) : (
                <Stagger className="space-y-1.5">
                  {filteredCollections.map((collection) => (
                    <StaggerItem
                      key={collection.id}
                      className="group rounded-md bg-muted border border-border hover:border-primary/30 hover:bg-accent transition-all shadow-sm"
                    >
                      <div className="flex items-center justify-between gap-2 p-2.5">
                        <div className="flex-1 flex items-center gap-2 min-w-0">
                          <FolderPlus className="h-3.5 w-3.5 text-primary shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              {renamingCollectionId === collection.id ? (
                                <input
                                  ref={collectionRenameRef}
                                  value={collectionRenameValue}
                                  onChange={(e) => setCollectionRenameValue(e.target.value)}
                                  onBlur={commitCollectionRename}
                                  onKeyDown={(e) => {
                                    e.stopPropagation();
                                    if (e.key === 'Enter') commitCollectionRename();
                                    if (e.key === 'Escape') setRenamingCollectionId(null);
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                  className="flex-1 bg-transparent border-b border-primary outline-none text-xs font-medium text-foreground"
                                  aria-label="Rename collection"
                                />
                              ) : (
                                <span className="text-xs font-medium truncate">
                                  {collection.name}
                                </span>
                              )}
                              <FileStatusBadge collectionId={collection.id} />
                            </div>
                            <span className="text-[10px] text-muted-foreground">
                              {collection.items.length}{' '}
                              {collection.items.length === 1 ? 'item' : 'items'}
                            </span>
                          </div>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 opacity-0 group-hover:opacity-100 shrink-0"
                              onPointerDown={(e) => e.stopPropagation()}
                              aria-label="Collection options"
                            >
                              <MoreVertical className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => setRunnerScope({ collectionId: collection.id })}
                              className="text-xs"
                            >
                              <Play className="mr-2 h-3.5 w-3.5" />
                              Run collection
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => handleAddRequest(collection.id)}
                              className="text-xs"
                            >
                              <FilePlus className="mr-2 h-3.5 w-3.5" />
                              New request
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handleAddFolder(collection.id)}
                              className="text-xs"
                            >
                              <FolderPlus className="mr-2 h-3.5 w-3.5" />
                              New folder
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => startCollectionRename(collection.id, collection.name)}
                              className="text-xs"
                            >
                              <Pencil className="mr-2 h-3.5 w-3.5" />
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handleDuplicateCollection(collection.id)}
                              className="text-xs"
                            >
                              <Copy className="mr-2 h-3.5 w-3.5" />
                              Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setDocsCollection(collection)}
                              className="text-xs"
                            >
                              <FileText className="mr-2 h-3.5 w-3.5" />
                              View API docs
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger className="text-xs">
                                <Download className="mr-2 h-3.5 w-3.5" />
                                Export
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent>
                                <DropdownMenuItem
                                  onClick={() => handleExportCollection(collection.id, 'postman')}
                                  className="text-xs"
                                >
                                  Postman Collection
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => handleExportCollection(collection.id, 'insomnia')}
                                  className="text-xs"
                                >
                                  Insomnia Collection
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() =>
                                    handleExportCollection(collection.id, 'opencollection')
                                  }
                                  className="text-xs"
                                >
                                  OpenCollection (YAML)
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => handleExportCollection(collection.id, 'bruno')}
                                  className="text-xs"
                                >
                                  Bruno (.bru archive)
                                </DropdownMenuItem>
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                            {isElectronEnvironment() && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={() => handleToggleMock(collection.id)}
                                  className="text-xs"
                                >
                                  {mockStatus.running &&
                                  mockStatus.collectionId === collection.id ? (
                                    <>
                                      <Square className="mr-2 h-3.5 w-3.5" />
                                      Stop mock server
                                    </>
                                  ) : (
                                    <>
                                      <Play className="mr-2 h-3.5 w-3.5" />
                                      Start mock server
                                    </>
                                  )}
                                </DropdownMenuItem>
                                {isFileCollection(collection.id) ? (
                                  <>
                                    <DropdownMenuItem
                                      onClick={() => {
                                        const dir =
                                          useFileCollectionStore.getState().fileCollections[
                                            collection.id
                                          ]?.directoryPath;
                                        if (dir) setGitTarget({ collection, directoryPath: dir });
                                      }}
                                      className="text-xs"
                                    >
                                      <GitBranch className="mr-2 h-3.5 w-3.5" />
                                      Git…
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => handleOpenInExplorer(collection.id)}
                                      className="text-xs"
                                    >
                                      <FolderOpen className="mr-2 h-3.5 w-3.5" />
                                      Open in Finder
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => handleSyncCollection(collection.id)}
                                      className="text-xs"
                                    >
                                      <HardDrive className="mr-2 h-3.5 w-3.5" />
                                      Sync to Disk
                                    </DropdownMenuItem>
                                  </>
                                ) : (
                                  <DropdownMenuItem
                                    onClick={() => handleSaveToFiles(collection.id)}
                                    className="text-xs"
                                  >
                                    <HardDrive className="mr-2 h-3.5 w-3.5" />
                                    Save to Files
                                  </DropdownMenuItem>
                                )}
                              </>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => setSettingsTarget({ scope: 'collection', collection })}
                              className="text-xs"
                            >
                              <Settings2 className="mr-2 h-3.5 w-3.5" />
                              Collection settings
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => handleDeleteClick(collection.id)}
                              className="text-destructive focus:text-destructive text-xs"
                            >
                              <Trash2 className="mr-2 h-3.5 w-3.5" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- drag-and-drop drop target; keyboard tree navigation handled via onKeyDown */}
                      <div
                        role="group"
                        aria-label={`${collection.name} items`}
                        className={cn(
                          'border-t border-border/60 px-2 py-1.5',
                          dropTargetId === `root:${collection.id}` &&
                            'bg-primary/5 ring-1 ring-inset ring-primary'
                        )}
                        onDragOver={(e) => {
                          if (!dragItemRef.current) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          setDropTargetId(`root:${collection.id}`);
                        }}
                        onDragLeave={() =>
                          setDropTargetId((id) => (id === `root:${collection.id}` ? null : id))
                        }
                        onDrop={(e) => handleDropToRoot(e, collection.id)}
                        onKeyDown={(e) => handleTreeKeyDown(e, treeActions, collapsedFolders)}
                      >
                        {collection.items.length > 0 ? (
                          <div className="space-y-0.5">
                            <CollectionTreeItems
                              collectionId={collection.id}
                              items={collection.items}
                              state={treeState}
                              actions={treeActions}
                            />
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 py-1">
                            <button
                              type="button"
                              onClick={() => handleAddRequest(collection.id)}
                              className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                            >
                              <FilePlus className="h-3 w-3" /> Add request
                            </button>
                            <button
                              type="button"
                              onClick={() => handleAddFolder(collection.id)}
                              className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                            >
                              <FolderPlus className="h-3 w-3" /> Add folder
                            </button>
                          </div>
                        )}
                      </div>
                    </StaggerItem>
                  ))}
                </Stagger>
              )}
            </div>
            <ConfirmDialog
              open={deleteDialogOpen}
              onOpenChange={setDeleteDialogOpen}
              title="Delete Collection"
              description="Are you sure you want to delete this collection? This action cannot be undone."
              confirmText="Delete"
              cancelText="Cancel"
              onConfirm={handleConfirmDelete}
              variant="destructive"
            />
          </TabsContent>

          <TabsContent value="history" className="flex-1 overflow-auto p-3 mt-0">
            {/* Method filter buttons */}
            {totalHistoryCount > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-3">
                <Button
                  variant={methodFilter === null ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-6 text-[10px] px-2"
                  onClick={() => setMethodFilter(null)}
                >
                  All
                </Button>
                {['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map((method) => (
                  <Button
                    key={method}
                    variant={methodFilter === method ? 'secondary' : 'ghost'}
                    size="sm"
                    className={cn(
                      'h-6 text-[10px] font-mono px-2',
                      methodFilter === method && METHOD_COLORS[method]
                    )}
                    onClick={() => setMethodFilter(methodFilter === method ? null : method)}
                  >
                    {method}
                  </Button>
                ))}
              </div>
            )}

            {filteredHistory.length === 0 ? (
              <div className="text-center text-xs py-10 px-3">
                <div className="mx-auto mb-3 h-12 w-12 rounded-xl bg-gradient-to-br from-muted to-muted/50 flex items-center justify-center">
                  <History className="h-6 w-6 text-sp-dim" />
                </div>
                <p className="font-medium text-foreground">
                  {searchQuery || methodFilter ? 'No matching requests' : 'No history yet'}
                </p>
                <p className="text-xs mt-1 text-muted-foreground">
                  {searchQuery || methodFilter
                    ? 'Try adjusting your filters'
                    : 'Send a request to see it here'}
                </p>
              </div>
            ) : (
              <Stagger className="space-y-1.5">
                {filteredHistory.map((item) => (
                  <StaggerItem
                    key={item.id}
                    className="group p-2.5 rounded-md bg-muted border border-border hover:border-primary/30 hover:bg-accent cursor-pointer transition-all shadow-sm"
                    onClick={() => handleLoadHistoryItem(item.id)}
                  >
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(item.id);
                        }}
                        aria-label={
                          favorites.includes(item.id) ? 'Remove from favorites' : 'Add to favorites'
                        }
                      >
                        <Star
                          className={cn(
                            'h-3.5 w-3.5 transition-all',
                            favorites.includes(item.id)
                              ? 'text-amber-500 fill-amber-500 scale-110'
                              : 'text-sp-dim group-hover:text-amber-500'
                          )}
                        />
                      </Button>
                      <Badge
                        variant={
                          item.request.type === 'http'
                            ? (item.request.method.toLowerCase() as
                                | 'get'
                                | 'post'
                                | 'put'
                                | 'delete'
                                | 'patch'
                                | 'options'
                                | 'head')
                            : 'mono'
                        }
                        className="text-[9px] h-4 px-1"
                      >
                        {item.request.type === 'http'
                          ? item.request.method
                          : PROTOCOL_LABELS[item.request.type]}
                      </Badge>
                      {item.response &&
                        (() => {
                          // gRPC stores its code in status (OK === 0); map it onto the
                          // HTTP range so a successful gRPC call isn't badged as an error.
                          const status = httpLikeStatus(item.request.type, item.response.status);
                          return (
                            <span
                              className={cn(
                                'text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded tabular-nums',
                                status >= 200 && status < 300
                                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                  : status >= 400
                                    ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                                    : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                              )}
                            >
                              {status}
                            </span>
                          );
                        })()}
                    </div>
                    <p className="text-xs font-mono truncate pl-6 mb-1 text-foreground">
                      {item.request.type === 'grpc' ? item.request.service : item.request.url}
                    </p>
                    <span className="text-[10px] text-muted-foreground pl-6 flex items-center gap-1">
                      <History className="h-3 w-3" />
                      {new Date(item.timestamp).toLocaleString()}
                    </span>
                  </StaggerItem>
                ))}
              </Stagger>
            )}
            {hasMoreHistory && !searchQuery && !methodFilter && (
              <Button
                variant="outline"
                size="sm"
                className="w-full mt-3 text-xs"
                onClick={handleLoadMore}
              >
                Load More ({totalHistoryCount - visibleHistoryCount} remaining)
              </Button>
            )}
          </TabsContent>

          <TabsContent value="workflows" className="flex-1 overflow-auto p-3 mt-0">
            {filteredCollections.length === 0 ? (
              <div className="text-center text-xs py-10 px-3">
                <div className="mx-auto mb-3 h-12 w-12 rounded-xl bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center">
                  <GitBranch className="h-6 w-6 text-primary/60" />
                </div>
                <p className="font-medium text-foreground">No collections yet</p>
                <p className="text-xs mt-1 text-muted-foreground">
                  Create a collection first to add workflows
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {filteredCollections.map((collection) => (
                  <div key={collection.id}>
                    <div className="text-xs font-medium text-muted-foreground mb-2 px-1">
                      {collection.name}
                    </div>
                    <WorkflowManager
                      collectionId={collection.id}
                      onSelectWorkflow={(workflow) => setSelectedWorkflow(workflow)}
                      onRunWorkflow={(workflow) => setRunningWorkflow(workflow)}
                    />
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

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
              setRunningWorkflow(selectedWorkflow);
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
          open={directoryPickerOpen}
          onOpenChange={setDirectoryPickerOpen}
          mode={directoryPickerMode}
          collectionId={saveCollectionId}
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

      <CollectionRunnerDialog scope={runnerScope} onClose={() => setRunnerScope(null)} />

      <CollectionSettingsDialog target={settingsTarget} onClose={() => setSettingsTarget(null)} />

      <ExportSecretsDialog
        open={exportPrompt !== null}
        secretCount={exportPrompt?.secretCount ?? 0}
        onCancel={() => setExportPrompt(null)}
        onExport={(includeSecrets) => {
          if (!exportPrompt) return;
          const { collection, format } = exportPrompt;
          setExportPrompt(null);
          void performExport(
            includeSecrets ? collection : redactCollectionSecrets(collection),
            format
          );
        }}
      />

      <DocsViewer collection={docsCollection} onClose={() => setDocsCollection(null)} />

      <GitDialog
        open={gitTarget !== null}
        collectionName={gitTarget?.collection.name ?? ''}
        directoryPath={gitTarget?.directoryPath ?? null}
        onClose={() => setGitTarget(null)}
      />
    </TooltipProvider>
  );
}

export default withErrorBoundary(Sidebar);
