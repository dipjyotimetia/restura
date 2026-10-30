import { AlertTriangle } from 'lucide-react';

interface UnappliedAuthNoticeProps {
  message: string;
  testId?: string;
}

/**
 * Warning shown beside credentials that are configured but won't go on the
 * wire here. Callers pass the protocol- or platform-specific reason (e.g.
 * GraphQL subscriptions, #882; NTLM on web/self-host, #1069).
 */
export function UnappliedAuthNotice({
  message,
  testId = 'unapplied-auth-warning',
}: UnappliedAuthNoticeProps) {
  return (
    <p
      className="p-3 rounded bg-amber-500/10 border border-amber-500/20 text-xs text-amber-500 flex items-center gap-2"
      data-testid={testId}
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      {message}
    </p>
  );
}
