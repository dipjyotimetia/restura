import { AlertTriangle } from 'lucide-react';

type UnappliedAuthNoticeProps =
  | { scheme: 'NTLM'; message?: never; testId?: never }
  | { scheme?: never; message: string; testId?: string };

/**
 * Warning shown beside credentials that are configured but won't go on the
 * wire. NTLM: no current backend applies the scheme (tracked in #1069), so the
 * stored credentials are unused. Digest is answered at the wire by the shared
 * HTTP proxy, so it no longer uses this. Callers with a protocol-specific
 * reason (e.g. GraphQL subscriptions, #882) pass their own `message`.
 */
export function UnappliedAuthNotice(props: UnappliedAuthNoticeProps) {
  const testId =
    props.scheme !== undefined
      ? `${props.scheme.toLowerCase()}-unimplemented-warning`
      : (props.testId ?? 'unapplied-auth-warning');
  return (
    <p
      className="p-3 rounded bg-amber-500/10 border border-amber-500/20 text-xs text-amber-500 flex items-center gap-2"
      data-testid={testId}
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      {props.scheme !== undefined
        ? `${props.scheme} authentication isn’t applied yet — the request is sent without authentication. Credentials below are saved but not used.`
        : props.message}
    </p>
  );
}
