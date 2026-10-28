import { useEffect, useRef } from 'react';

/**
 * Keep a panel's composer state in sync with the in-memory draft map
 * (`composerDrafts.ts`) for the WebSocket / Socket.IO panels (#1209):
 *
 *  - On a connection switch, a stored draft (written by an opened collection
 *    item, or mirrored earlier for that connection) is applied via `apply`.
 *    Without one the composer keeps its current text.
 *  - Edits are mirrored back with `save` so Save to Collection captures them.
 *    The first commit after a switch is skipped: its state still belongs to
 *    the previous connection and must not be written under the new id.
 */
export function useComposerDraftSync<T>(
  connectionId: string | null,
  current: T,
  load: (connectionId: string | null) => T | undefined,
  save: (connectionId: string, draft: T) => void,
  apply: (draft: T) => void
): void {
  const mirroredFor = useRef<string | null>(null);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const loadRef = useRef(load);
  loadRef.current = load;
  const saveRef = useRef(save);
  saveRef.current = save;
  const currentRef = useRef(current);
  currentRef.current = current;
  const key = JSON.stringify(current);

  useEffect(() => {
    const draft = loadRef.current(connectionId);
    if (draft) applyRef.current(draft);
  }, [connectionId]);

  useEffect(() => {
    if (!connectionId) return;
    if (mirroredFor.current !== connectionId) {
      mirroredFor.current = connectionId;
      return;
    }
    saveRef.current(connectionId, currentRef.current);
  }, [connectionId, key]);
}
