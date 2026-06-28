/**
 * Listens for capture sessions pushed from the Restura browser extension over
 * the desktop loopback bridge (`window.electron.capture.onReceived`). Each
 * arrival is an OpenCollection document; we NEVER import silently — the user
 * must confirm, because any local process holding the bridge token could push a
 * document (see ADR 0024). Desktop-only; renders nothing until a doc arrives.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { importOpenCollection } from '@/features/collections/lib/importers/opencollection';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { useCollectionStore } from '@/store/useCollectionStore';

interface PendingImport {
  doc: unknown;
  itemCount: number;
}

export function CaptureImportListener() {
  const addCollection = useCollectionStore((s) => s.addCollection);
  const [pending, setPending] = useState<PendingImport | null>(null);

  useEffect(() => {
    if (!isElectron()) return;
    const api = getElectronAPI();
    if (!api?.capture) return;

    api.capture.onReceived((doc) => {
      const items = (doc as { items?: unknown[] })?.items;
      setPending({ doc, itemCount: Array.isArray(items) ? items.length : 0 });
    });
    return () => api.capture.removeReceivedListener();
  }, []);

  const confirmImport = () => {
    if (!pending) return;
    try {
      const result = importOpenCollection(pending.doc);
      addCollection(result.collection);
      toast.success('Captured collection imported', {
        description: `${result.collection.name} — ${pending.itemCount} request(s).`,
      });
    } catch (err) {
      toast.error('Could not import captured collection', {
        description: err instanceof Error ? err.message : 'Invalid capture payload.',
      });
    } finally {
      setPending(null);
    }
  };

  return (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
      title="Import captured session?"
      description={`The Restura capture extension sent a session with ${pending?.itemCount ?? 0} request(s). Import it as a new collection?`}
      confirmText="Import"
      cancelText="Discard"
      onConfirm={confirmImport}
    />
  );
}
