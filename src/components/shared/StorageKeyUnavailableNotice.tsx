import { type ReactElement, useEffect, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { isStorageKeyUnavailable, STORAGE_KEY_UNAVAILABLE_EVENT } from '@/lib/shared/dexie-storage';

/**
 * Blocking notice for an unreadable encryption key. Storage fails closed (the
 * key is never replaced), so saved data cannot load and nothing new can be
 * saved: the user must know before they make changes that would be lost.
 * Deliberately not dismissible; the only way out is a reload once the
 * keychain is available again.
 */
export function StorageKeyUnavailableNotice(): ReactElement | null {
  const [unavailable, setUnavailable] = useState(isStorageKeyUnavailable);

  useEffect(() => {
    const handler = () => setUnavailable(true);
    window.addEventListener(STORAGE_KEY_UNAVAILABLE_EVENT, handler);
    // The event may have fired before this listener mounted.
    if (isStorageKeyUnavailable()) setUnavailable(true);
    return () => window.removeEventListener(STORAGE_KEY_UNAVAILABLE_EVENT, handler);
  }, []);

  if (!unavailable) return null;

  return (
    <AlertDialog open>
      <AlertDialogContent onEscapeKeyDown={(event) => event.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Saved data is locked</AlertDialogTitle>
          <AlertDialogDescription>
            Restura found its encryption key but could not read it from the OS keychain, so your
            saved collections, environments and history cannot be loaded. Nothing has been deleted,
            but changes made now will not be saved. Unlock the keychain (or allow Restura to access
            it), then reload.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={() => window.location.reload()}>Reload</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
