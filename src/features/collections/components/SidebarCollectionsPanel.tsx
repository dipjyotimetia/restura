import {
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
  MoreVertical,
  Pencil,
  Play,
  Settings2,
  Square,
  Trash2,
} from 'lucide-react';
import type { DragEvent, RefObject } from 'react';
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
import { Stagger, StaggerItem } from '@/components/ui/motion';
import { TabsContent } from '@/components/ui/tabs';
import { cn } from '@/lib/shared/utils';
import type { Collection, MockServerStatus } from '@/types';
import {
  CollectionTreeItems,
  handleTreeKeyDown,
  type TreeActions,
  type TreeState,
} from './CollectionTree';
import { CollectionWorkspaceActions } from './CollectionWorkspaceActions';
import { FileStatusBadge } from './FileStatusBadge';
import { SidebarEmptyState } from './SidebarEmptyState';

export type ExportFormat = 'postman' | 'insomnia' | 'opencollection' | 'bruno';

interface SidebarCollectionsPanelProps {
  collections: Collection[];
  collapsedCollections: Set<string>;
  collapsedFolders: Set<string>;
  dropTargetId: string | null;
  hasDraggedItem: () => boolean;
  isElectron: boolean;
  isFileCollection: (collectionId: string) => boolean;
  mockStatus: MockServerStatus;
  renamingCollectionId: string | null;
  collectionRenameValue: string;
  collectionRenameRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  staggerInitial: false | 'hidden';
  treeActions: TreeActions;
  treeState: TreeState;
  onAddFolder: (collectionId: string) => void;
  onAddRequest: (collectionId: string) => void;
  onCloneWorkspace: () => void;
  onCollectionDragOver: (collectionId: string) => void;
  onConfirmCollectionRename: () => void;
  onDeleteCollection: (collectionId: string) => void;
  onDropToRoot: (event: DragEvent, collectionId: string) => void;
  onDuplicateCollection: (collectionId: string) => void;
  onExportCollection: (collectionId: string, format: ExportFormat) => void;
  onGit: (collection: Collection) => void;
  onOpenFromFolder: () => void;
  onOpenInExplorer: (collectionId: string) => void;
  onOpenSettings: (collection: Collection) => void;
  onOpenDocs: (collection: Collection) => void;
  onRunCollection: (collectionId: string) => void;
  onSaveToFiles: (collectionId: string) => void;
  onSetCollectionRenameValue: (value: string) => void;
  onStartCollectionRename: (collectionId: string, name: string) => void;
  onSyncCollection: (collectionId: string) => void;
  onToggleCollectionCollapse: (collectionId: string) => void;
  onToggleMock: (collectionId: string) => void;
  onNewCollection: () => void;
  onCancelCollectionRename: () => void;
  onSetDropTarget: (id: string | null) => void;
}

export function SidebarCollectionsPanel({
  collections,
  collapsedCollections,
  collapsedFolders,
  dropTargetId,
  hasDraggedItem,
  isElectron,
  isFileCollection,
  mockStatus,
  renamingCollectionId,
  collectionRenameValue,
  collectionRenameRef,
  searchQuery,
  staggerInitial,
  treeActions,
  treeState,
  onAddFolder,
  onAddRequest,
  onCloneWorkspace,
  onCollectionDragOver,
  onConfirmCollectionRename,
  onDeleteCollection,
  onDropToRoot,
  onDuplicateCollection,
  onExportCollection,
  onGit,
  onOpenFromFolder,
  onOpenInExplorer,
  onOpenSettings,
  onOpenDocs,
  onRunCollection,
  onSaveToFiles,
  onSetCollectionRenameValue,
  onStartCollectionRename,
  onSyncCollection,
  onToggleCollectionCollapse,
  onToggleMock,
  onNewCollection,
  onCancelCollectionRename,
  onSetDropTarget,
}: SidebarCollectionsPanelProps) {
  return (
    <TabsContent value="collections" className="flex-1 overflow-auto p-3 mt-0 min-h-0">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1">
          <Button
            onClick={onNewCollection}
            variant="ghost"
            size="sm"
            className="flex-1 justify-start h-7 px-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <FolderPlus className="mr-1.5 h-3.5 w-3.5" /> New collection
          </Button>
          {isElectron && (
            <CollectionWorkspaceActions onOpen={onOpenFromFolder} onClone={onCloneWorkspace} />
          )}
        </div>

        {collections.length === 0 ? (
          <SidebarEmptyState
            icon={FolderPlus}
            title={searchQuery ? 'No collections found' : 'No collections yet'}
            hint={
              searchQuery ? 'Try a different search term' : 'Create one to organize your requests'
            }
          />
        ) : (
          <Stagger className="flex flex-col" initial={staggerInitial}>
            {collections.map((collection) => {
              const isCollectionCollapsed = collapsedCollections.has(collection.id);
              const toggleHeader = () => {
                if (renamingCollectionId !== collection.id)
                  onToggleCollectionCollapse(collection.id);
              };
              return (
                <StaggerItem
                  key={collection.id}
                  className="group border-b border-border/40 pb-1.5 mb-1.5 last:border-b-0 last:mb-0 last:pb-0"
                >
                  {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- drag affordance only; its child owns keyboard interaction */}
                  <div
                    className="flex items-center gap-2 rounded px-1.5 py-1.5 hover:bg-accent transition-colors"
                    onDragOver={() => onCollectionDragOver(collection.id)}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      aria-expanded={!isCollectionCollapsed}
                      onClick={toggleHeader}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
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
                            onChange={(event) => onSetCollectionRenameValue(event.target.value)}
                            onBlur={onConfirmCollectionRename}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === 'Enter') onConfirmCollectionRename();
                              if (event.key === 'Escape') onCancelCollectionRename();
                            }}
                            onClick={(event) => event.stopPropagation()}
                            className="flex-1 bg-transparent border-b border-primary outline-none text-xs font-medium text-foreground"
                            aria-label="Rename collection"
                          />
                        ) : (
                          <span className="text-xs font-medium truncate">{collection.name}</span>
                        )}
                        <FileStatusBadge collectionId={collection.id} />
                        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-sp-dim">
                          {collection.items.length}
                        </span>
                      </div>
                    </div>
                    <CollectionMenu
                      collection={collection}
                      isElectron={isElectron}
                      isFileCollection={isFileCollection(collection.id)}
                      isMockRunning={
                        mockStatus.running && mockStatus.collectionId === collection.id
                      }
                      onAddFolder={onAddFolder}
                      onAddRequest={onAddRequest}
                      onDelete={onDeleteCollection}
                      onDuplicate={onDuplicateCollection}
                      onExport={onExportCollection}
                      onGit={onGit}
                      onOpenDocs={onOpenDocs}
                      onOpenInExplorer={onOpenInExplorer}
                      onOpenSettings={onOpenSettings}
                      onRun={onRunCollection}
                      onSaveToFiles={onSaveToFiles}
                      onStartRename={onStartCollectionRename}
                      onSync={onSyncCollection}
                      onToggleMock={onToggleMock}
                    />
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
                      onDragOver={(event) => {
                        if (!hasDraggedItem()) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                        onSetDropTarget(`root:${collection.id}`);
                      }}
                      onDragLeave={() =>
                        onSetDropTarget(
                          dropTargetId === `root:${collection.id}` ? null : dropTargetId
                        )
                      }
                      onDrop={(event) => onDropToRoot(event, collection.id)}
                      onKeyDown={(event) => handleTreeKeyDown(event, treeActions, collapsedFolders)}
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
                            onClick={() => onAddRequest(collection.id)}
                            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                          >
                            <FilePlus className="h-3 w-3" /> Add request
                          </button>
                          <button
                            type="button"
                            onClick={() => onAddFolder(collection.id)}
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
    </TabsContent>
  );
}

interface CollectionMenuProps {
  collection: Collection;
  isElectron: boolean;
  isFileCollection: boolean;
  isMockRunning: boolean;
  onAddFolder: (collectionId: string) => void;
  onAddRequest: (collectionId: string) => void;
  onDelete: (collectionId: string) => void;
  onDuplicate: (collectionId: string) => void;
  onExport: (collectionId: string, format: ExportFormat) => void;
  onGit: (collection: Collection) => void;
  onOpenDocs: (collection: Collection) => void;
  onOpenInExplorer: (collectionId: string) => void;
  onOpenSettings: (collection: Collection) => void;
  onRun: (collectionId: string) => void;
  onSaveToFiles: (collectionId: string) => void;
  onStartRename: (collectionId: string, name: string) => void;
  onSync: (collectionId: string) => void;
  onToggleMock: (collectionId: string) => void;
}

function CollectionMenu({
  collection,
  isElectron,
  isFileCollection,
  isMockRunning,
  onAddFolder,
  onAddRequest,
  onDelete,
  onDuplicate,
  onExport,
  onGit,
  onOpenDocs,
  onOpenInExplorer,
  onOpenSettings,
  onRun,
  onSaveToFiles,
  onStartRename,
  onSync,
  onToggleMock,
}: CollectionMenuProps) {
  return (
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
        <DropdownMenuItem onClick={() => onRun(collection.id)} className="text-xs">
          <Play className="mr-2 h-3.5 w-3.5" />
          Run collection
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onAddRequest(collection.id)} className="text-xs">
          <FilePlus className="mr-2 h-3.5 w-3.5" />
          New request
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAddFolder(collection.id)} className="text-xs">
          <FolderPlus className="mr-2 h-3.5 w-3.5" />
          New folder
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => onStartRename(collection.id, collection.name)}
          className="text-xs"
        >
          <Pencil className="mr-2 h-3.5 w-3.5" />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onDuplicate(collection.id)} className="text-xs">
          <Copy className="mr-2 h-3.5 w-3.5" />
          Duplicate
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onOpenDocs(collection)} className="text-xs">
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
              onClick={() => onExport(collection.id, 'postman')}
              className="text-xs"
            >
              Postman Collection
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onExport(collection.id, 'insomnia')}
              className="text-xs"
            >
              Insomnia Collection
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onExport(collection.id, 'opencollection')}
              className="text-xs"
            >
              OpenCollection (YAML)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onExport(collection.id, 'bruno')} className="text-xs">
              Bruno (.bru archive)
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {isElectron && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onToggleMock(collection.id)} className="text-xs">
              {isMockRunning ? (
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
            {isFileCollection ? (
              <>
                <DropdownMenuItem onClick={() => onGit(collection)} className="text-xs">
                  <GitBranch className="mr-2 h-3.5 w-3.5" />
                  Git…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => onOpenInExplorer(collection.id)}
                  className="text-xs"
                >
                  <FolderOpen className="mr-2 h-3.5 w-3.5" />
                  Open in Finder
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onSync(collection.id)} className="text-xs">
                  <HardDrive className="mr-2 h-3.5 w-3.5" />
                  Sync to Disk
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuItem onClick={() => onSaveToFiles(collection.id)} className="text-xs">
                <HardDrive className="mr-2 h-3.5 w-3.5" />
                Save to Files
              </DropdownMenuItem>
            )}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onOpenSettings(collection)} className="text-xs">
          <Settings2 className="mr-2 h-3.5 w-3.5" />
          Collection settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => onDelete(collection.id)}
          className="text-destructive focus:text-destructive text-xs"
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
