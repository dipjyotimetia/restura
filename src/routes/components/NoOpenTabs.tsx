import { FolderOpen, Sparkles } from 'lucide-react';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';
import { Button } from '@/components/ui/button';
import { Floater, ProtoChip } from '@/components/ui/spatial';
import { addSampleCollection } from '@/features/collections/lib/addSampleCollection';
import { MODE_DESCRIPTORS, MODES_IN_MENU_ORDER } from '@/features/registry/modes';
import { isElectron } from '@/lib/shared/platform';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { RequestMode } from '@/types';

export const NEW_REQUEST_PROTOCOLS: ReadonlyArray<{
  mode: RequestMode;
  chip: string;
  label: string;
  desktopOnly?: boolean;
}> = MODES_IN_MENU_ORDER.map((mode) => {
  const d = MODE_DESCRIPTORS[mode];
  return { mode, chip: d.chip, label: d.label, ...(d.desktopOnly ? { desktopOnly: true } : {}) };
});

interface NoOpenTabsProps {
  onNewRequest: (mode: RequestMode) => void;
  onOpenImport: () => void;
}

/** Workspace shown after every tab is closed, so the pane is never blank. */
export function NoOpenTabs({ onNewRequest, onOpenImport }: NoOpenTabsProps) {
  // Raw-TCP protocols stay visible (disabled + badge) on web, matching the
  // tab strip's "+" menu, so users can discover them.
  const desktop = isElectron();
  // The sample is offered only to a workspace that has no collections yet.
  const hasCollections = useCollectionStore((s) => s.collections.length > 0);
  return (
    <Floater
      radius="panel"
      elevation="float-lg"
      className="flex-1 m-2 flex flex-col items-center justify-center gap-5 px-6 text-center"
    >
      <div className="space-y-1">
        <h2 className="text-sp-13 font-medium text-sp-text">No open requests</h2>
        <p className="text-sp-12 text-sp-muted">
          Start a new request, or pick one from the sidebar.
        </p>
      </div>
      <ul className="flex flex-wrap justify-center gap-2 max-w-lg" aria-label="New request">
        {NEW_REQUEST_PROTOCOLS.map((p) => (
          <li key={p.mode}>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={p.desktopOnly && !desktop}
              onClick={() => onNewRequest(p.mode)}
            >
              <ProtoChip protocol={p.chip} />
              {p.label}
              {p.desktopOnly && !desktop && <DesktopOnlyBadge />}
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="ghost" size="sm" className="gap-2" onClick={onOpenImport}>
          <FolderOpen className="h-4 w-4" aria-hidden="true" />
          Import a collection
        </Button>
        {!hasCollections && (
          <Button variant="ghost" size="sm" className="gap-2" onClick={addSampleCollection}>
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            Try sample collection
          </Button>
        )}
      </div>
    </Floater>
  );
}
