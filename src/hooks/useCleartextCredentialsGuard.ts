import { useConfirmDialog } from '@/components/shared/ConfirmDialog';
import {
  CLEARTEXT_CREDENTIALS_CONFIRM,
  type CredentialSources,
  carriesCredentials,
  isCleartextSocketUrl,
} from '@/lib/shared/browserSocketPolicy';

type GuardSources = CredentialSources & { force?: boolean };

/** True when connecting to `url` would send credentials unencrypted (ws:// / http://). */
export function needsCleartextConfirm(url: string, sources: GuardSources): boolean {
  if (!isCleartextSocketUrl(url)) return false;
  return sources.force === true || carriesCredentials({ url, ...sources });
}

/**
 * Asks before a socket client sends credentials over ws:// or http:// (#898).
 * Callers check `needsConfirm` first and only await `confirm()` when it
 * is true, so the common path stays synchronous. Render `Dialog` once.
 */
export function useCleartextCredentialsGuard() {
  const { confirm, DialogComponent } = useConfirmDialog(CLEARTEXT_CREDENTIALS_CONFIRM);
  return { needsConfirm: needsCleartextConfirm, confirm, Dialog: DialogComponent };
}
