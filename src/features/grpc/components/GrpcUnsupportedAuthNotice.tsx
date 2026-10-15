import { AlertTriangle } from 'lucide-react';
import { useInheritedAuth } from '@/features/auth/components/InheritedAuthHint';
import { grpcUnsupportedAuthMessage } from '@/features/grpc/lib/grpcClient';
import type { AuthConfig } from '@/types';

/**
 * Inline warning on the gRPC auth tab when the effective auth (the request's
 * own, or the folder/collection auth it inherits) has no gRPC binding (#900).
 * Send is blocked for these types in `prepareGrpcRequest`; this explains why
 * before the user tries.
 */
export function GrpcUnsupportedAuthNotice({
  request,
}: {
  request: { id: string; auth: AuthConfig };
}) {
  const inherited = useInheritedAuth(request);
  const message = grpcUnsupportedAuthMessage(inherited?.auth ?? request.auth);
  if (!message) return null;
  return (
    <p
      role="alert"
      className="p-3 rounded bg-amber-500/10 border border-amber-500/20 text-xs text-amber-500 flex items-center gap-2"
      data-testid="grpc-auth-unsupported-warning"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      {inherited ? `Inherited from ${inherited.sourceName}: ${message}` : message}
    </p>
  );
}
