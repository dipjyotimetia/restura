import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
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
import { countCollectionInlineSecrets } from '@/lib/shared/collection-secret-redaction';
import { downloadBlob } from '@/lib/shared/file-utils';
import { getElectronAPI } from '@/lib/shared/platform';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import {
  openCollectionInExplorer,
  syncFileCollection,
  useFileCollectionStore,
} from '@/store/useFileCollectionStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useMockStore } from '@/store/useMockStore';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import type { Collection, OpenAPIDocument } from '@/types';
import type { RunnerScope } from '../components/CollectionRunnerDialog';
import type { SettingsTarget } from '../components/CollectionSettingsDialog';
import type { ExportFormat } from '../components/SidebarCollectionsPanel';
import { duplicateCollection } from '../lib/itemFactory';
import { buildMockRoutes, buildMockRoutesFromSpec, mergeMockRoutes } from '../lib/mockRoutes';
import { isNameTaken, siblingNamesOfItem, uniqueName } from '../lib/names';

export interface ExportPrompt {
  collection: Collection;
  format: ExportFormat;
  secretCount: number;
}

/**
 * Owns the command side of the collection sidebar. Rendering components receive
 * only explicit callbacks, which keeps persistence, export, file, Git and
 * destructive behavior out of the sidebar shell.
 */
export function useCollectionSidebarCommands() {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [collectionToDelete, setCollectionToDelete] = useState<string | null>(null);
  const [settingsTarget, setSettingsTarget] = useState<SettingsTarget | null>(null);
  const [docsCollection, setDocsCollection] = useState<Collection | null>(null);
  const [gitTarget, setGitTarget] = useState<{
    collection: Collection;
    directoryPath: string;
  } | null>(null);
  const [exportPrompt, setExportPrompt] = useState<ExportPrompt | null>(null);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [directoryPickerMode, setDirectoryPickerMode] = useState<'open' | 'save' | 'clone'>('open');
  const [saveCollectionId, setSaveCollectionId] = useState<string | undefined>();
  const [renamingCollectionId, setRenamingCollectionId] = useState<string | null>(null);
  const [collectionRenameValue, setCollectionRenameValue] = useState('');
  const collectionRenameRef = useRef<HTMLInputElement>(null);
  const collectionRenameValueRef = useRef(collectionRenameValue);
  collectionRenameValueRef.current = collectionRenameValue;
  const [renamingItemId, setRenamingItemId] = useState<string | null>(null);
  const [itemRenameValue, setItemRenameValue] = useState('');
  const itemRenameRef = useRef<HTMLInputElement>(null);
  const itemRenameValueRef = useRef(itemRenameValue);
  itemRenameValueRef.current = itemRenameValue;
  const [runnerScope, setRunnerScope] = useState<RunnerScope | null>(null);

  const startCollectionRename = useCallback((id: string, name: string) => {
    setRenamingCollectionId(id);
    setCollectionRenameValue(name);
    setTimeout(() => setTimeout(() => collectionRenameRef.current?.select(), 0), 0);
  }, []);

  const handleNewCollection = useCallback(() => {
    const store = useCollectionStore.getState();
    const collection = store.createNewCollection(
      uniqueName(
        'New Collection',
        store.collections.map((item) => item.name)
      )
    );
    store.addCollection(collection);
    startCollectionRename(collection.id, collection.name);
  }, [startCollectionRename]);

  const commitCollectionRename = useCallback(() => {
    const name = collectionRenameValueRef.current.trim();
    if (renamingCollectionId && name) {
      const store = useCollectionStore.getState();
      const otherNames = store.collections
        .filter((collection) => collection.id !== renamingCollectionId)
        .map((collection) => collection.name);
      if (isNameTaken(name, otherNames)) toast.error(`A collection named "${name}" already exists`);
      else store.updateCollection(renamingCollectionId, { name });
    }
    setRenamingCollectionId(null);
  }, [renamingCollectionId]);

  const startItemRename = useCallback((itemId: string, name: string) => {
    setRenamingItemId(itemId);
    setItemRenameValue(name);
    setTimeout(() => setTimeout(() => itemRenameRef.current?.select(), 0), 0);
  }, []);

  const commitItemRename = useCallback((collectionId: string, itemId: string) => {
    const name = itemRenameValueRef.current.trim();
    const store = useCollectionStore.getState();
    const collection = store.getCollectionById(collectionId);
    if (name) {
      if (collection && isNameTaken(name, siblingNamesOfItem(collection, itemId)))
        toast.error(`An item named "${name}" already exists at this level`);
      else store.updateCollectionItem(collectionId, itemId, { name });
    }
    setRenamingItemId(null);
  }, []);

  const warnAboutOmittedWorkflows = useCallback((collection: Collection) => {
    const count = useWorkflowStore
      .getState()
      .workflows.filter((workflow) => workflow.collectionId === collection.id).length;
    if (count > 0)
      toast.warning(
        `This export format doesn't support workflows — ${count} workflow${count === 1 ? '' : 's'} in "${collection.name}" ${count === 1 ? 'was' : 'were'} not included.`
      );
  }, []);

  const performExport = useCallback(
    async (collection: Collection, format: ExportFormat) => {
      if (format === 'postman' || format === 'insomnia' || format === 'opencollection') {
        const warnings = getCollectionExportWarnings(collection, format);
        if (warnings.length > 0)
          toast.warning(
            `${warnings[0]}${warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ''}`
          );
      }
      if (format === 'postman') {
        downloadJSON(exportToPostman(collection), `${collection.name}.postman_collection.json`);
      } else if (format === 'insomnia') {
        downloadJSON(exportToInsomnia(collection), `${collection.name}.insomnia.json`);
      } else if (format === 'opencollection') {
        downloadText(
          exportToOpenCollection(collection),
          `${collection.name}.opencollection.yaml`,
          'application/x-yaml'
        );
      } else {
        const { exportBrunoCollection } = await import('../lib/bruno-exporter');
        const exported = await exportBrunoCollection(collection, {
          environments: useEnvironmentStore.getState().environments,
        });
        if (exported.kind !== 'directory') return;
        const api = getElectronAPI();
        if (api?.collections) {
          const directory = await api.collections.selectDirectory();
          if (directory.canceled || !directory.filePaths?.[0]) return;
          const saved = await api.collections.saveBrunoToDirectory(
            exported.entries,
            directory.filePaths[0]
          );
          if (!saved.success) {
            toast.error(saved.error ?? 'Bruno export failed');
            return;
          }
          toast.success(`Exported ${exported.entries.length} files to ${directory.filePaths[0]}`);
        } else {
          const { zipEntries } = await import('@/lib/shared/zip-utils');
          downloadBlob(
            await zipEntries(exported.entries),
            `${collection.name}.bruno.zip`,
            'application/zip'
          );
        }
        if (exported.warnings.length > 0) {
          const first = exported.warnings[0]!;
          toast.warning(
            `Bruno export: ${first.message}${exported.warnings.length > 1 ? ` (+${exported.warnings.length - 1} more)` : ''}`
          );
        }
      }
      warnAboutOmittedWorkflows(collection);
    },
    [warnAboutOmittedWorkflows]
  );

  const handleExportCollection = useCallback(
    async (collectionId: string, format: ExportFormat) => {
      const collection = useCollectionStore.getState().getCollectionById(collectionId);
      if (!collection) return;
      const secretCount = countCollectionInlineSecrets(collection);
      if (secretCount > 0) {
        setExportPrompt({ collection, format, secretCount });
        return;
      }
      await performExport(collection, format);
    },
    [performExport]
  );

  const handleDuplicateCollection = useCallback((collectionId: string) => {
    const store = useCollectionStore.getState();
    const collection = store.getCollectionById(collectionId);
    if (collection)
      store.addCollection(
        duplicateCollection(
          collection,
          store.collections.map((item) => item.name)
        )
      );
  }, []);

  const handleToggleMock = useCallback(async (collectionId: string) => {
    const api = getElectronAPI();
    if (!api?.mock) {
      toast.error('Mock server is only available in the desktop app');
      return;
    }
    const mockStore = useMockStore.getState();
    if (mockStore.status.running && mockStore.status.collectionId === collectionId) {
      const result = await api.mock.stop();
      if (result.ok) {
        mockStore.setStatus(result.status);
        mockStore.setRoutes([]);
        toast.success('Mock server stopped');
      } else toast.error(`Failed to stop mock server: ${result.error}`);
      return;
    }
    const collection = useCollectionStore.getState().getCollectionById(collectionId);
    if (!collection) return;
    const historyRoutes = buildMockRoutes(collection, useHistoryStore.getState().history);
    let specRouteCount = 0;
    let routes = historyRoutes;
    if (collection.contractSpec) {
      const loaded = await loadContractSpec(collection.contractSpec);
      if (loaded.ok) {
        routes = mergeMockRoutes(
          historyRoutes,
          buildMockRoutesFromSpec(loaded.spec as unknown as OpenAPIDocument)
        );
        specRouteCount = routes.length - historyRoutes.length;
      } else toast.warning(`Attached OpenAPI spec failed to load: ${loaded.error}`);
    }
    if (routes.length === 0) {
      toast.warning('No HTTP requests or OpenAPI spec to mock in this collection');
      return;
    }
    const result = await api.mock.start({ collectionId, routes });
    if (!result.ok) {
      toast.error(`Failed to start mock server: ${result.error}`);
      return;
    }
    mockStore.setStatus(result.status);
    mockStore.setRoutes(routes.map((route) => ({ method: route.method, path: route.path })));
    toast.success(`Mock server running at ${result.status.baseUrl}`, {
      description:
        specRouteCount > 0
          ? `${historyRoutes.length} from history · ${specRouteCount} from spec`
          : `${result.status.routeCount} route${result.status.routeCount === 1 ? '' : 's'} · replays recorded responses`,
    });
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

  const openDirectoryPicker = useCallback(
    (mode: 'open' | 'save' | 'clone', collectionId?: string) => {
      setDirectoryPickerMode(mode);
      setSaveCollectionId(collectionId);
      setDirectoryPickerOpen(true);
    },
    []
  );

  const handleOpenGit = useCallback((collection: Collection) => {
    const directoryPath =
      useFileCollectionStore.getState().fileCollections[collection.id]?.directoryPath;
    if (directoryPath) setGitTarget({ collection, directoryPath });
  }, []);

  const handleSyncCollection = useCallback(async (collectionId: string) => {
    const result = await syncFileCollection(collectionId);
    if (!result.success) toast.error('Collection sync failed', { description: result.error });
  }, []);

  return {
    collectionRenameRef,
    collectionRenameValue,
    commitCollectionRename,
    commitItemRename,
    deleteDialogOpen,
    directoryPickerMode,
    directoryPickerOpen,
    docsCollection,
    exportPrompt,
    gitTarget,
    handleConfirmDelete,
    handleDuplicateCollection,
    handleExportCollection,
    handleNewCollection,
    handleOpenGit,
    handleSyncCollection,
    handleToggleMock,
    itemRenameRef,
    itemRenameValue,
    openDirectoryPicker,
    performExport,
    renamingCollectionId,
    renamingItemId,
    runnerScope,
    saveCollectionId,
    setCollectionRenameValue,
    setCollectionToDelete,
    setDeleteDialogOpen,
    setDirectoryPickerOpen,
    setDocsCollection,
    setExportPrompt,
    setGitTarget,
    setRenamingCollectionId,
    setRenamingItemId,
    setItemRenameValue,
    setRunnerScope,
    setSettingsTarget,
    settingsTarget,
    startCollectionRename,
    startItemRename,
    openCollectionInExplorer,
  };
}
