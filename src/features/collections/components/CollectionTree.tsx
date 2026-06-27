import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  Folder,
  FolderPlus,
  Pencil,
  Play,
  Settings2,
  Copy,
  Trash2,
} from 'lucide-react';
import {
  memo,
  useMemo,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { METHOD_COLORS, PROTOCOL_COLORS, PROTOCOL_LABELS } from '@/lib/shared/constants';
import { cn } from '@/lib/shared/utils';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { CollectionItem } from '@/types';

/**
 * Collection tree rows, extracted from the Sidebar monolith so each row is a
 * `memo`-ized component. Volatile state (rename, drop target, collapse,
 * selection) is passed as per-row booleans — a rename keystroke or drop-target
 * change re-renders only the affected rows instead of every row in every
 * collection. The `actions` object is identity-stable (one `useMemo` in the
 * Sidebar), so it never breaks memoization.
 */

export interface FolderEntry {
  id: string;
  name: string;
  depth: number;
}

/** Stable callback bundle owned by the Sidebar. */
export interface TreeActions {
  openItem: (item: CollectionItem) => void;
  addRequest: (collectionId: string, parentId?: string) => void;
  addFolder: (collectionId: string, parentId?: string) => void;
  duplicateItem: (collectionId: string, item: CollectionItem) => void;
  deleteItem: (collectionId: string, itemId: string) => void;
  /** Bulk-delete every selected item in this collection. */
  deleteSelected: (collectionId: string) => void;
  runFolder: (collectionId: string, folderId: string) => void;
  openFolderSettings: (collectionId: string, item: CollectionItem) => void;
  startRename: (itemId: string, currentName: string) => void;
  commitRename: (collectionId: string, itemId: string) => void;
  cancelRename: () => void;
  setRenameValue: (value: string) => void;
  renameInputRef: RefObject<HTMLInputElement | null>;
  toggleCollapse: (folderId: string) => void;
  /** Cmd/Ctrl-click multi-select toggle. */
  toggleSelect: (collectionId: string, itemId: string) => void;
  clearSelection: () => void;
  dragStart: (e: DragEvent, collectionId: string, itemId: string) => void;
  dragEnd: () => void;
  setDropTarget: (id: string | null) => void;
  dropIntoFolder: (e: DragEvent, collectionId: string, folderId: string) => void;
  dropBeforeItem: (e: DragEvent, collectionId: string, beforeId: string) => void;
  moveToFolder: (collectionId: string, itemId: string, folderId: string) => void;
}

/** Volatile tree state, owned by the Sidebar, fanned out per row. */
export interface TreeState {
  renamingItemId: string | null;
  renameValue: string;
  dropTargetId: string | null;
  collapsedFolders: Set<string>;
  /** Selection keys are `${collectionId}:${itemId}`. */
  selectedKeys: Set<string>;
}

export const selectionKey = (collectionId: string, itemId: string) => `${collectionId}:${itemId}`;

/**
 * Container-level keyboard navigation. Attach to the element wrapping the
 * rows of one collection: ↑/↓ move focus across visible rows, → expands a
 * collapsed folder, ← collapses, Enter/Space activate (buttons natively;
 * folder rows toggle). Rename inputs swallow their own keys.
 */
export function handleTreeKeyDown(
  e: KeyboardEvent<HTMLElement>,
  actions: Pick<TreeActions, 'toggleCollapse'>,
  collapsedFolders: Set<string>
) {
  if (e.target instanceof HTMLInputElement) return; // renaming — leave keys alone
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-tree-row]'));
  if (rows.length === 0) return;
  const active = document.activeElement as HTMLElement | null;
  const idx = active ? rows.indexOf(active) : -1;

  const focusRow = (i: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
    row?.focus();
  };

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      focusRow(idx + 1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      focusRow(idx <= 0 ? 0 : idx - 1);
      break;
    case 'ArrowRight': {
      const id = active?.dataset['itemId'];
      if (id && active?.dataset['itemType'] === 'folder' && collapsedFolders.has(id)) {
        e.preventDefault();
        actions.toggleCollapse(id);
      }
      break;
    }
    case 'ArrowLeft': {
      const id = active?.dataset['itemId'];
      if (id && active?.dataset['itemType'] === 'folder' && !collapsedFolders.has(id)) {
        e.preventDefault();
        actions.toggleCollapse(id);
      }
      break;
    }
    case 'Enter':
    case ' ': {
      // Request rows are <button>s — the browser activates them natively.
      if (active?.dataset['itemType'] === 'folder' && active.dataset['itemId']) {
        e.preventDefault();
        actions.toggleCollapse(active.dataset['itemId']);
      }
      break;
    }
  }
}

interface RenameInputProps {
  actions: TreeActions;
  collectionId: string;
  itemId: string;
  value: string;
  ariaLabel: string;
}

function RenameInput({ actions, collectionId, itemId, value, ariaLabel }: RenameInputProps) {
  return (
    <input
      ref={actions.renameInputRef}
      value={value}
      onChange={(e) => actions.setRenameValue(e.target.value)}
      onBlur={() => actions.commitRename(collectionId, itemId)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') actions.commitRename(collectionId, itemId);
        if (e.key === 'Escape') actions.cancelRename();
      }}
      onClick={(e) => e.stopPropagation()}
      className="flex-1 bg-transparent border-b border-primary outline-none text-[11px] text-foreground"
      aria-label={ariaLabel}
    />
  );
}

interface FolderRowProps {
  collectionId: string;
  item: CollectionItem;
  depth: number;
  isRenaming: boolean;
  renameValue: string;
  isDropTarget: boolean;
  isCollapsed: boolean;
  isSelected: boolean;
  selectedCount: number;
  actions: TreeActions;
}

const FolderRow = memo(function FolderRow({
  collectionId,
  item,
  depth,
  isRenaming,
  renameValue,
  isDropTarget,
  isCollapsed,
  isSelected,
  selectedCount,
  actions,
}: FolderRowProps) {
  const indent = Math.min(depth, 3) * 10;
  const childCount = item.items?.length ?? 0;

  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (isRenaming) return;
    if (e.metaKey || e.ctrlKey) {
      actions.toggleSelect(collectionId, item.id);
      return;
    }
    actions.clearSelection();
    actions.toggleCollapse(item.id);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-tree-row
          data-item-id={item.id}
          data-item-type="folder"
          tabIndex={0}
          role="button"
          aria-expanded={!isCollapsed}
          draggable={!isRenaming}
          onClick={handleClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              if (isRenaming) return;
              actions.clearSelection();
              actions.toggleCollapse(item.id);
            }
          }}
          onDragStart={(e) => actions.dragStart(e, collectionId, item.id)}
          onDragEnd={actions.dragEnd}
          onDragOver={(e) => {
            e.preventDefault();
            // Stop the bubble so the collection root strip's
            // onDragOver doesn't overwrite this row's drop highlight.
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            if (!isDropTarget) actions.setDropTarget(item.id);
          }}
          onDragLeave={() => {
            if (isDropTarget) actions.setDropTarget(null);
          }}
          onDrop={(e) => actions.dropIntoFolder(e, collectionId, item.id)}
          className={cn(
            'group flex items-center gap-1.5 min-w-0 rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-accent cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            isDropTarget && 'ring-1 ring-primary bg-primary/5',
            isSelected && 'bg-primary/10 text-foreground'
          )}
          style={{ marginLeft: indent }}
        >
          {isCollapsed ? (
            <ChevronRight className="h-3 w-3 shrink-0 text-sp-muted" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0 text-sp-muted" />
          )}
          <Folder className="h-3 w-3 shrink-0 text-primary/60" />
          {isRenaming ? (
            <RenameInput
              actions={actions}
              collectionId={collectionId}
              itemId={item.id}
              value={renameValue}
              ariaLabel="Rename folder"
            />
          ) : (
            <>
              <span className="truncate">{item.name}</span>
              {isCollapsed && childCount > 0 && (
                <span className="ml-auto shrink-0 text-[9px] tabular-nums text-sp-dim">
                  {childCount}
                </span>
              )}
            </>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          className="text-xs"
          onClick={() => actions.runFolder(collectionId, item.id)}
        >
          <Play className="mr-2 h-3.5 w-3.5" />
          Run folder
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-xs"
          onClick={() => actions.addRequest(collectionId, item.id)}
        >
          <FilePlus className="mr-2 h-3.5 w-3.5" />
          New request
        </ContextMenuItem>
        <ContextMenuItem
          className="text-xs"
          onClick={() => actions.addFolder(collectionId, item.id)}
        >
          <FolderPlus className="mr-2 h-3.5 w-3.5" />
          New subfolder
        </ContextMenuItem>
        <ContextMenuItem
          className="text-xs"
          onClick={() => actions.startRename(item.id, item.name)}
        >
          <Pencil className="mr-2 h-3.5 w-3.5" />
          Rename
        </ContextMenuItem>
        <ContextMenuItem
          className="text-xs"
          onClick={() => actions.openFolderSettings(collectionId, item)}
        >
          <Settings2 className="mr-2 h-3.5 w-3.5" />
          Folder settings
        </ContextMenuItem>
        <ContextMenuSeparator />
        {isSelected && selectedCount > 1 ? (
          <ContextMenuItem
            className="text-destructive focus:text-destructive text-xs"
            onClick={() => actions.deleteSelected(collectionId)}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            Delete selected ({selectedCount})
          </ContextMenuItem>
        ) : (
          <ContextMenuItem
            className="text-destructive focus:text-destructive text-xs"
            onClick={() => actions.deleteItem(collectionId, item.id)}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            Delete
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

function flatFolderItems(items: CollectionItem[], depth = 0): FolderEntry[] {
  return items.flatMap((i) =>
    i.type === 'folder'
      ? [{ id: i.id, name: i.name, depth }, ...flatFolderItems(i.items ?? [], depth + 1)]
      : []
  );
}

/**
 * Sub-menu content for "Move to folder". Reads from getState() (no subscription)
 * to avoid the useSyncExternalStore infinite-loop that occurs when the selector
 * produces a new array reference on every call. This component mounts only when
 * the sub-menu opens, so getState() is always current at that point.
 */
function MoveToFolderSubContent({
  collectionId,
  itemId,
  actions,
}: {
  collectionId: string;
  itemId: string;
  actions: TreeActions;
}) {
  const folders = useMemo(() => {
    const col = useCollectionStore.getState().collections.find((c) => c.id === collectionId);
    return col ? flatFolderItems(col.items) : [];
  }, [collectionId]);

  return (
    <ContextMenuSubContent>
      {folders.length === 0 ? (
        <ContextMenuItem disabled className="text-xs text-muted-foreground">
          No folders in this collection
        </ContextMenuItem>
      ) : (
        folders.map(({ id, name, depth }) => (
          <ContextMenuItem
            key={id}
            className="text-xs"
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => actions.moveToFolder(collectionId, itemId, id)}
          >
            <Folder className="mr-2 h-3.5 w-3.5 shrink-0" />
            {name}
          </ContextMenuItem>
        ))
      )}
    </ContextMenuSubContent>
  );
}

interface RequestRowProps {
  collectionId: string;
  item: CollectionItem;
  depth: number;
  isRenaming: boolean;
  renameValue: string;
  isDropTarget: boolean;
  isSelected: boolean;
  selectedCount: number;
  actions: TreeActions;
}

const RequestRow = memo(function RequestRow({
  collectionId,
  item,
  depth,
  isRenaming,
  renameValue,
  isDropTarget,
  isSelected,
  selectedCount,
  actions,
}: RequestRowProps) {
  const indent = Math.min(depth, 3) * 10;
  const request = item.request;
  const label =
    request?.type === 'http' ? request.method : (PROTOCOL_LABELS[request?.type ?? ''] ?? 'REQ');
  const color =
    request?.type === 'http' ? METHOD_COLORS[request.method] : PROTOCOL_COLORS[request?.type ?? ''];

  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (isRenaming) return;
    if (e.metaKey || e.ctrlKey) {
      actions.toggleSelect(collectionId, item.id);
      return;
    }
    actions.clearSelection();
    actions.openItem(item);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          data-tree-row
          data-item-id={item.id}
          data-item-type="request"
          draggable={!isRenaming}
          onDragStart={(e) => actions.dragStart(e, collectionId, item.id)}
          onDragEnd={actions.dragEnd}
          onDragOver={(e) => {
            e.preventDefault();
            // Stop the bubble so the collection root strip's onDragOver
            // doesn't overwrite this row's drop highlight.
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            if (!isDropTarget) actions.setDropTarget(item.id);
          }}
          onDragLeave={() => {
            if (isDropTarget) actions.setDropTarget(null);
          }}
          onDrop={(e) => actions.dropBeforeItem(e, collectionId, item.id)}
          className={cn(
            'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-grab active:cursor-grabbing',
            isDropTarget && 'border-t-2 border-primary',
            isSelected && 'bg-primary/10'
          )}
          style={{ marginLeft: indent }}
          onClick={handleClick}
        >
          <span
            className={cn(
              'shrink-0 rounded px-1 py-0.5 text-[9px] font-mono font-medium leading-none',
              color ?? 'bg-muted text-muted-foreground border border-border'
            )}
          >
            {label}
          </span>
          {isRenaming ? (
            <RenameInput
              actions={actions}
              collectionId={collectionId}
              itemId={item.id}
              value={renameValue}
              ariaLabel="Rename request"
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-foreground">{item.name}</span>
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          className="text-xs"
          onClick={() => actions.startRename(item.id, item.name)}
        >
          <Pencil className="mr-2 h-3.5 w-3.5" />
          Rename
        </ContextMenuItem>
        <ContextMenuItem
          className="text-xs"
          onClick={() => actions.duplicateItem(collectionId, item)}
        >
          <Copy className="mr-2 h-3.5 w-3.5" />
          Duplicate
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger className="text-xs">
            <Folder className="mr-2 h-3.5 w-3.5" />
            Move to folder
          </ContextMenuSubTrigger>
          <MoveToFolderSubContent collectionId={collectionId} itemId={item.id} actions={actions} />
        </ContextMenuSub>
        <ContextMenuSeparator />
        {isSelected && selectedCount > 1 ? (
          <ContextMenuItem
            className="text-destructive focus:text-destructive text-xs"
            onClick={() => actions.deleteSelected(collectionId)}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            Delete selected ({selectedCount})
          </ContextMenuItem>
        ) : (
          <ContextMenuItem
            className="text-destructive focus:text-destructive text-xs"
            onClick={() => actions.deleteItem(collectionId, item.id)}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            Delete
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

interface CollectionTreeItemsProps {
  collectionId: string;
  items: CollectionItem[];
  depth?: number;
  state: TreeState;
  actions: TreeActions;
}

/**
 * Recursive renderer for one collection's items. The list re-renders on any
 * volatile-state change, but each row is memoized on its own booleans —
 * unaffected rows skip their render entirely.
 */
export function CollectionTreeItems({
  collectionId,
  items,
  depth = 0,
  state,
  actions,
}: CollectionTreeItemsProps) {
  // Selection count within this collection (cheap: selection sets are tiny).
  const prefix = `${collectionId}:`;
  let selectedCount = 0;
  for (const key of state.selectedKeys) {
    if (key.startsWith(prefix)) selectedCount++;
  }

  return (
    <>
      {items.map((item) => {
        const isRenaming = item.id === state.renamingItemId;
        const common = {
          collectionId,
          item,
          depth,
          isRenaming,
          renameValue: isRenaming ? state.renameValue : '',
          isDropTarget: item.id === state.dropTargetId,
          isSelected: state.selectedKeys.has(selectionKey(collectionId, item.id)),
          selectedCount,
          actions,
        };

        if (item.type === 'folder') {
          const isCollapsed = state.collapsedFolders.has(item.id);
          return (
            <div key={item.id} className="space-y-1">
              <FolderRow {...common} isCollapsed={isCollapsed} />
              {!isCollapsed && item.items && item.items.length > 0 && (
                <CollectionTreeItems
                  collectionId={collectionId}
                  items={item.items}
                  depth={depth + 1}
                  state={state}
                  actions={actions}
                />
              )}
            </div>
          );
        }

        return <RequestRow key={item.id} {...common} />;
      })}
    </>
  );
}
