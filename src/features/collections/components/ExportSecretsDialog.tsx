import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Shown before exporting a collection that contains plaintext (inline)
 * secrets. Exports default to REDACTED — the file is shared with teammates,
 * committed to git, pasted into chat tools — and including credentials is an
 * explicit opt-in per export. Keychain-handle secrets are never at risk here
 * (they export as opaque `{{handle:label}}` placeholders either way).
 */
interface Props {
  /** Number of plaintext secrets found; null/0 closes the dialog. */
  secretCount: number;
  open: boolean;
  onCancel: () => void;
  /** Called with the user's choice; the caller runs the actual export. */
  onExport: (includeSecrets: boolean) => void;
}

export function ExportSecretsDialog({ secretCount, open, onCancel, onExport }: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader icon={ShieldAlert} tone="warning">
          <DialogTitle>This export contains secrets</DialogTitle>
          <DialogDescription>
            {secretCount} plaintext credential{secretCount === 1 ? '' : 's'} (tokens, passwords, API
            keys) would be written into the exported file. Redacted exports keep the auth
            configuration but blank the credential values.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="outline" onClick={() => onExport(true)}>
            Include secrets
          </Button>
          <Button onClick={() => onExport(false)}>Export redacted</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
