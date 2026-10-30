import { useEffect, useRef } from 'react';

/**
 * Keep a panel's composer state in sync with the in-memory draft map
 * (`composerDrafts.ts`) for the WebSocket / Socket.IO panels (#1209):
 *
 *  - On a connection switch the composer shows that connection's stored
 *    draft (written by an opened collection item, or mirrored earlier). A
 *    connection without one gets `defaults`, which are stored right away, so
 *    the composer never shows another connection's text and Save to
 *    Collection always captures what is on screen.
 *  - Edits are mirrored back with `save`. The first commit after a switch is
 *    skipped: its state still belongs to the previous connection and must not
 *    be written under the new id.
 */
export function useComposerDraftSync<T>(
  connectionId: string | null,
  current: T,
  load: (connectionId: string | null) => T | undefined,
  save: (connectionId: string, draft: T) => void,
  apply: (draft: T) => void,
  defaults: T
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
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const key = JSON.stringify(current);

  useEffect(() => {
    if (!connectionId) return;
    const stored = loadRef.current(connectionId);
    const draft = stored ?? defaultsRef.current;
    if (!stored) saveRef.current(connectionId, draft);
    applyRef.current(draft);
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
