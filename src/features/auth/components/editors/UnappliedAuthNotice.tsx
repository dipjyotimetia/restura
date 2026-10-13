import { AlertTriangle } from 'lucide-react';

/**
 * NTLM configurations persist, but no current backend applies the scheme
 * (tracked in #1069). Keep the warning beside the editable credentials so
 * callers cannot mistake stored data for wire authentication. Digest is
 * answered at the wire by the shared HTTP proxy, so it no longer uses this.
 */
export function UnappliedAuthNotice({ scheme }: { scheme: 'NTLM' }) {
  return (
    <p
      className="p-3 rounded bg-amber-500/10 border border-amber-500/20 text-xs text-amber-500 flex items-center gap-2"
      data-testid={`${scheme.toLowerCase()}-unimplemented-warning`}
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      {scheme} authentication isn’t applied yet — the request is sent without authentication.
      Credentials below are saved but not used.
    </p>
  );
}
