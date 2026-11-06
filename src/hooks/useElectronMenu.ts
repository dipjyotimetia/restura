import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { ExportFormat } from '@/features/collections/components/exportMenuItems';
import { onMenuEvent } from '@/lib/shared/platform';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useRequestStore } from '@/store/useRequestStore';

/** The native menu has no format submenu; use the sidebar's default (#1229). */
const MENU_EXPORT_FORMAT: ExportFormat = 'postman-v3';

/**
 * The collection that File > Export Collection… (CmdOrCtrl+E) targets: the one that
 * owns the active tab's saved request, else the only collection. `undefined`
 * when there is no unambiguous target.
 */
export function resolveMenuExportCollectionId(): string | undefined {
  const savedRequestId = useRequestStore.getState().getActiveTab()?.savedRequestId;
  const store = useCollectionStore.getState();
  if (savedRequestId) {
    const owner = store.getCollectionByItemId(savedRequestId);
    if (owner) return owner.id;
  }
  return store.collections.length === 1 ? store.collections[0]?.id : undefined;
}

/**
 * Subscribe to the desktop `menu:export` event and hand the resolved collection
 * to the sidebar's export flow (which owns the inline-secret prompt). Only
 * `menu:export` lives here — `menu:import` / `menu:new-request` and the other
 * menu events are handled in `src/routes/index.tsx`. No-op outside Electron
 * (`onMenuEvent` returns a no-op unsubscribe).
 */
export function useElectronMenuExport(
  onExport: (collectionId: string, format: ExportFormat) => void
): void {
  const onExportRef = useRef(onExport);
  onExportRef.current = onExport;
  useEffect(
    () =>
      onMenuEvent('menu:export', () => {
        const collectionId = resolveMenuExportCollectionId();
        if (collectionId) {
          onExportRef.current(collectionId, MENU_EXPORT_FORMAT);
          return;
        }
        toast.info(
          useCollectionStore.getState().collections.length === 0
            ? 'No collection to export'
            : "Open a saved request, or use a collection's Export menu in the sidebar"
        );
      }),
    []
  );
}
