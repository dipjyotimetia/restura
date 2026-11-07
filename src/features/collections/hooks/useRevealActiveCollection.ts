import { type RefObject, useEffect } from 'react';
import { useCollectionStore } from '@/store/useCollectionStore';

/**
 * When the store's active collection changes (e.g. right after an import),
 * scroll its header row into view and give it the tree's tab stop, so the user
 * sees where the new collection landed. Focus is not moved (the import dialog
 * restores focus to its trigger).
 */
export function useRevealActiveCollection(
  treeRef: RefObject<HTMLElement | null>,
  makeTabStop: (row: HTMLElement) => void
): void {
  const activeCollectionId = useCollectionStore((s) => s.activeCollectionId);
  useEffect(() => {
    if (!activeCollectionId) return;
    const row = treeRef.current?.querySelector<HTMLElement>(
      `[data-item-type="collection"][data-item-id="${CSS.escape(activeCollectionId)}"]`
    );
    if (!row) return;
    row.scrollIntoView?.({ block: 'nearest' });
    makeTabStop(row);
  }, [activeCollectionId, treeRef, makeTabStop]);
}
