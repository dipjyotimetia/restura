import { useMemo } from 'react';
import { KeyRound } from 'lucide-react';
import { useCollectionStore } from '@/store/useCollectionStore';
import {
  findInheritedAuthWithSource,
  isConfiguredAuth,
  type InheritedAuth,
} from '@/features/auth/lib/authInheritance';
import type { AuthConfig, AuthType, Request } from '@/types';

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
  // Subscribe so the hint updates live when folder/collection auth changes.
  const collections = useCollectionStore((s) => s.collections);

  const inherited = useMemo<InheritedAuth | undefined>(() => {
    if (isConfiguredAuth(request.auth)) return undefined;
    for (const collection of collections) {
      const found = findInheritedAuthWithSource(collection, request.id);
      if (found) return found;
    }
    return undefined;
  }, [collections, request.id, request.auth]);

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
