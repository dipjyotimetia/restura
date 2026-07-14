import {
  Activity,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  HardDrive,
  History,
  type LucideIcon,
  MoreVertical,
  Pencil,
  Play,
  Settings2,
  Square,
  Star,
  Trash2,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Stagger, StaggerItem } from '@/components/ui/motion';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { deleteCollectionWithCleanup } from '@/features/collections/lib/deleteCollection';
import {
  downloadJSON,
  downloadText,
  exportToInsomnia,
  exportToOpenCollection,
  exportToPostman,
  getCollectionExportWarnings,
} from '@/features/collections/lib/exporters';
import { loadContractSpec } from '@/features/contracts/lib/specLoader';
import { WorkflowBuilder } from '@/features/workflows/components/WorkflowBuilder';
import { WorkflowExecutor } from '@/features/workflows/components/WorkflowExecutor';
import { WorkflowManager } from '@/features/workflows/components/WorkflowManager';
import {
  countCollectionInlineSecrets,
  redactCollectionSecrets,
} from '@/lib/shared/collection-secret-redaction';
import { httpLikeStatus } from '@/lib/shared/console-format';
import { METHOD_COLORS, PROTOCOL_LABELS } from '@/lib/shared/constants';
import { downloadBlob } from '@/lib/shared/file-utils';
import { getElectronAPI } from '@/lib/shared/platform';
import { cn } from '@/lib/shared/utils';
import { selectFavoriteIds, selectHistoryCount } from '@/store/selectors';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import {
  isElectronEnvironment,
  openCollectionInExplorer,
  syncFileCollection,
  useFileCollectionStore,
} from '@/store/useFileCollectionStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useMockStore } from '@/store/useMockStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import type { ActivePanel, Collection, CollectionItem, OpenAPIDocument, Workflow } from '@/types';
import {
  duplicateCollection,
  duplicateRequestItem,
  makeFolderItem,
  makeRequestItem,
} from '../lib/itemFactory';
import { buildMockRoutes, buildMockRoutesFromSpec, mergeMockRoutes } from '../lib/mockRoutes';
import {
  folderPathTo,
  isNameTaken,
  moveWouldCollide,
  parentFolderIdOf,
  siblingNamesForParent,
  siblingNamesOfItem,
  uniqueName,
} from '../lib/names';
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

type ExportFormat = 'postman' | 'insomnia' | 'opencollection' | 'bruno';

/** Quiet empty state shared by the collections / history / workflows tabs. */
function SidebarEmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
}) {
  return (
    <div className="text-center text-xs py-10 px-3">
      <Icon className="mx-auto mb-2.5 h-5 w-5 text-sp-dim" />
      <p className="text-muted-foreground">{title}</p>
      <p className="text-[11px] mt-1 text-sp-dim">{hint}</p>
    </div>
  );
}

function Sidebar({ activePanel }: SidebarProps) {
  const {
    collections,
    createNewCollection,
    addCollection,
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

  const startCollectionRename = useCallback((id: string, currentName: string) => {
    setRenamingCollectionId(id);
    setCollectionRenameValue(currentName);
    // Double-setTimeout to outlast Radix DropdownMenu's FocusScope cleanup,
    // which uses setTimeout(fn, 0) to return focus to the trigger.
    setTimeout(() => setTimeout(() => collectionRenameRef.current?.select(), 0), 0);
  }, []);

  const handleNewCollection = useCallback(() => {
    const name = uniqueName(
      'New Collection',
      collections.map((c) => c.name)
    );
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
      if (format === 'postman' || format === 'insomnia' || format === 'opencollection') {
        const warnings = getCollectionExportWarnings(collection, format);
        if (warnings.length > 0) {
          const extra = warnings.length > 1 ? ` (+${warnings.length - 1} more)` : '';
          toast.warning(`${warnings[0]}${extra}`);
        }
      }
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
        const { environments } = useEnvironmentStore.getState();
        const exported = await exportBrunoCollection(collection, { environments });
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
      addCollection(
        duplicateCollection(
          collection,
          collections.map((c) => c.name)
        )
      );
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

  const handleConfirmDelete = useCallback(async () => {
    if (collectionToDelete) {
      const result = await deleteCollectionWithCleanup(collectionToDelete);
      if (!result.success) {
        toast.error('Collection was not deleted', { description: result.error });
        return;
      }
      setCollectionToDelete(null);
    }
    setDeleteDialogOpen(false);
  }, [collectionToDelete]);

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
    const result = await syncFileCollection(collectionId);
    if (!result.success) toast.error('Collection sync failed', { description: result.error });
  }, []);

  const commitCollectionRename = useCallback(() => {
    const newName = collectionRenameValueRef.current.trim();
    if (renamingCollectionId && newName) {
      const otherNames = useCollectionStore
        .getState()
        .collections.filter((c) => c.id !== renamingCollectionId)
        .map((c) => c.name);
      if (isNameTaken(newName, otherNames)) {
        toast.error(`A collection named "${newName}" already exists`);
      } else {
        updateCollection(renamingCollectionId, { name: newName });
      }
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
      const newName = itemRenameValueRef.current.trim();
      if (newName) {
        const collection = getCollectionById(collectionId);
        if (collection && isNameTaken(newName, siblingNamesOfItem(collection, itemId))) {
          toast.error(`An item named "${newName}" already exists at this level`);
        } else {
          updateCollectionItem(collectionId, itemId, { name: newName });
        }
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
      const folder = makeFolderItem(uniqueName('New Folder', siblingNames(collectionId, parentId)));
      addItemToCollection(collectionId, folder, parentId);
      // Make sure the new folder is visible for the inline rename.
      revealLocation(collectionId, parentId);
      startItemRename(folder.id, folder.name);
    },
    [addItemToCollection, revealLocation, startItemRename]
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

  // Search forces every collapse level open so matches stay visible.
  const effectiveCollapsedFolders = searchQuery ? EMPTY_COLLAPSED : collapsedFolders;
  const effectiveCollapsedCollections = searchQuery ? EMPTY_COLLAPSED : collapsedCollections;
  const effectiveCollapsedWorkflowGroups = searchQuery ? EMPTY_COLLAPSED : collapsedWorkflowGroups;

  // Volatile tree state, fanned out to per-row booleans inside the tree.
  const treeState: TreeState = {
    renamingItemId,
    renameValue: itemRenameValue,
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

          <TabsContent value="collections" className="flex-1 overflow-auto p-3 mt-0 min-h-0">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1">
                <Button
                  onClick={handleNewCollection}
                  variant="ghost"
                  size="sm"
                  className="flex-1 justify-start h-7 px-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  <FolderPlus className="mr-1.5 h-3.5 w-3.5" />
                  New collection
                </Button>
                {isElectronEnvironment() && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        onClick={handleOpenFromFolder}
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-muted-foreground hover:text-foreground"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Open from folder</p>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>

              {filteredCollections.length === 0 ? (
                <SidebarEmptyState
                  icon={FolderPlus}
                  title={searchQuery ? 'No collections found' : 'No collections yet'}
                  hint={
                    searchQuery
                      ? 'Try a different search term'
                      : 'Create one to organize your requests'
                  }
                />
              ) : (
                <Stagger className="flex flex-col" initial={staggerInitial}>
                  {filteredCollections.map((collection) => {
                    const isCollectionCollapsed = effectiveCollapsedCollections.has(collection.id);
                    const toggleHeader = () => {
                      if (renamingCollectionId !== collection.id)
                        toggleCollectionCollapse(collection.id);
                    };
                    return (
                      <StaggerItem
                        key={collection.id}
                        className="group border-b border-border/40 pb-1.5 mb-1.5 last:border-b-0 last:mb-0 last:pb-0"
                      >
                        {/* The options menu is a sibling of the clickable area (not a
                            child) so menu clicks can't bubble into the collapse toggle
                            and the ARIA button contains no nested controls. */}
                        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- onDragOver is a drag affordance only; click/keyboard interactivity lives on the role="button" child */}
                        <div
                          className="flex items-center gap-2 rounded px-1.5 py-1.5 hover:bg-accent transition-colors"
                          onDragOver={() => {
                            // Spring-open a collapsed collection so it can accept drops.
                            if (dragItemRef.current) expandCollection(collection.id);
                          }}
                        >
                          <div
                            role="button"
                            tabIndex={0}
                            aria-expanded={!isCollectionCollapsed}
                            onClick={toggleHeader}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                toggleHeader();
                              }
                            }}
                            className="flex-1 flex items-center gap-2 min-w-0 cursor-pointer rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            {isCollectionCollapsed ? (
                              <ChevronRight className="h-3 w-3 text-sp-muted shrink-0" />
                            ) : (
                              <ChevronDown className="h-3 w-3 text-sp-muted shrink-0" />
                            )}
                            <Folder className="h-3.5 w-3.5 text-sp-muted shrink-0" />
                            <div className="min-w-0 flex-1 flex items-center gap-1.5">
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
                              <span className="ml-auto shrink-0 text-[10px] tabular-nums text-sp-dim">
                                {collection.items.length}
                              </span>
                            </div>
                          </div>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 opacity-0 group-hover:opacity-100 shrink-0"
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
                                onClick={() =>
                                  startCollectionRename(collection.id, collection.name)
                                }
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
                                    onClick={() =>
                                      handleExportCollection(collection.id, 'insomnia')
                                    }
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
                                onClick={() =>
                                  setSettingsTarget({ scope: 'collection', collection })
                                }
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
                        {!isCollectionCollapsed && (
                          <div
                            role="group"
                            aria-label={`${collection.name} items`}
                            className={cn(
                              'pl-3 pr-1 py-0.5',
                              dropTargetId === `root:${collection.id}` &&
                                'bg-primary/5 ring-1 ring-inset ring-primary rounded'
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
                            onKeyDown={(e) =>
                              handleTreeKeyDown(e, treeActions, effectiveCollapsedFolders)
                            }
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
                        )}
                      </StaggerItem>
                    );
                  })}
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
              <SidebarEmptyState
                icon={History}
                title={searchQuery || methodFilter ? 'No matching requests' : 'No history yet'}
                hint={
                  searchQuery || methodFilter
                    ? 'Try adjusting your filters'
                    : 'Send a request to see it here'
                }
              />
            ) : (
              <Stagger className="flex flex-col gap-0.5" initial={staggerInitial}>
                {filteredHistory.map((item) => (
                  <StaggerItem
                    key={item.id}
                    className="group px-1.5 py-1.5 rounded hover:bg-accent cursor-pointer transition-colors"
                    onClick={() => handleLoadHistoryItem(item.id)}
                  >
                    <div className="flex items-center gap-1.5 mb-1">
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
                      {item.request.type === 'grpc'
                        ? item.request.service
                        : (item.resolvedUrl ?? item.request.url)}
                    </p>
                    <span className="text-[10px] text-sp-dim pl-6 block">
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
              <SidebarEmptyState
                icon={GitBranch}
                title="No collections yet"
                hint="Create a collection first to add workflows"
              />
            ) : (
              <div className="space-y-4">
                {filteredCollections.map((collection) => {
                  const isGroupCollapsed = effectiveCollapsedWorkflowGroups.has(collection.id);
                  return (
                    <div key={collection.id}>
                      <div
                        role="button"
                        tabIndex={0}
                        aria-expanded={!isGroupCollapsed}
                        onClick={() => toggleWorkflowGroup(collection.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggleWorkflowGroup(collection.id);
                          }
                        }}
                        className="flex items-center gap-1.5 mb-2 px-1 rounded text-xs font-medium text-muted-foreground cursor-pointer hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        {isGroupCollapsed ? (
                          <ChevronRight className="h-3 w-3 shrink-0 text-sp-muted" />
                        ) : (
                          <ChevronDown className="h-3 w-3 shrink-0 text-sp-muted" />
                        )}
                        <span className="truncate">{collection.name}</span>
                        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-sp-dim">
                          {workflowCounts[collection.id] ?? 0}
                        </span>
                      </div>
                      {!isGroupCollapsed && (
                        <WorkflowManager
                          collectionId={collection.id}
                          onSelectWorkflow={(workflow) => setSelectedWorkflow(workflow)}
                          onRunWorkflow={(workflow) => setRunningWorkflow(workflow)}
                        />
                      )}
                    </div>
                  );
                })}
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
