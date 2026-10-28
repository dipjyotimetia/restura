import { postmanBlockedReasonFor } from '@shared/collections/postman/auth-guard';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { useMemo } from 'react';
import {
  findInheritedAuthWithSource,
  type InheritedAuth,
  isConfiguredAuth,
} from '@/features/auth/lib/authInheritance';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { AuthConfig, AuthType, Request } from '@/types';

/**
 * The folder/collection auth this request inherits, if it has none of its
 * own. Subscribes to the collection store so it updates live.
 */
export function useInheritedAuth(
  request: Pick<Request, 'id'> & { auth: AuthConfig }
): InheritedAuth | undefined {
  const collections = useCollectionStore((s) => s.collections);
  return useMemo(() => {
    if (isConfiguredAuth(request.auth)) return undefined;
    for (const collection of collections) {
      // A Postman-guard-blocked request inherits nothing (#1232).
      if (postmanBlockedReasonFor(collection, request.id, 'Restura', request.auth))
        return undefined;
      const found = findInheritedAuthWithSource(collection, request.id);
      if (found) return found;
    }
    return undefined;
  }, [collections, request.id, request.auth]);
}

/** Why the Postman send guard refuses this request (#1232), or `undefined`. Live. */
export function usePostmanSendBlock(
  request: Pick<Request, 'id'> & { auth: AuthConfig }
): string | undefined {
  const collections = useCollectionStore((s) => s.collections);
  return useMemo(() => {
    for (const collection of collections) {
      const reason = postmanBlockedReasonFor(collection, request.id, 'Restura', request.auth);
      if (reason) return reason;
    }
    return undefined;
  }, [collections, request.id, request.auth]);
}

export function authTypeLabel(type: AuthType): string {
  return AUTH_TYPE_LABELS[type] ?? type;
}

const AUTH_TYPE_LABELS: Partial<Record<AuthType, string>> = {
  basic: 'Basic',
  bearer: 'Bearer',
  'api-key': 'API Key',
  oauth2: 'OAuth 2.0',
  oauth1: 'OAuth 1.0',
  digest: 'Digest',
  'aws-signature': 'AWS Signature',
  ntlm: 'NTLM',
  wsse: 'WSSE',
};

/**
 * Passive hint shown in a request's Auth tab when the request has no auth of
 * its own but inherits one from an ancestor folder or its collection. Makes
 * the (otherwise invisible) send-time inheritance discoverable — the request
 * goes out with this auth even though the tab below says "None".
 */
export function InheritedAuthHint({
  request,
}: {
  request: Pick<Request, 'id'> & { auth: AuthConfig };
}) {
  const inherited = useInheritedAuth(request);
  const blocked = usePostmanSendBlock(request);

  if (blocked) {
    return (
      <div
        role="alert"
        className="mb-3 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground"
      >
        <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />
        <span>Not sent: {blocked.replace(/^not sent: /, '')}</span>
      </div>
    );
  }
  if (!inherited) return null;

  return (
    <div className="mb-3 flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
      <KeyRound className="h-3.5 w-3.5 shrink-0 text-primary/70" />
      <span>
        Inherits{' '}
        <span className="font-medium text-foreground">
          {AUTH_TYPE_LABELS[inherited.auth.type] ?? inherited.auth.type}
        </span>{' '}
        auth from <span className="font-medium text-foreground">“{inherited.sourceName}”</span> —
        sent with this request unless you configure auth below.
      </span>
    </div>
  );
}
