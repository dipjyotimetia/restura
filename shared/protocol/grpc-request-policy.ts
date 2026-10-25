/**
 * gRPC request pre-flight policy shared by every harness that prepares a call
 * (renderer `prepareGrpcRequest`, CLI `executeGrpc`): which auth types gRPC
 * can't apply (#900) and the aggregate metadata cap (#895). Both are checked
 * before anything is sent.
 */

import { MAX_GRPC_METADATA_BYTES } from './header-policy';

/**
 * Auth types with no gRPC binding yet (#900). Each needs either the exact wire
 * bytes (SigV4, OAuth 1.0 sign the encoded body/URL), a challenge/response
 * round-trip (Digest, NTLM), or a per-call computed header the gRPC handlers
 * don't build (WSSE). Rather than silently sending without credentials, the
 * send is blocked with this explanation (FAILED_PRECONDITION).
 */
export const GRPC_UNSUPPORTED_AUTH: Readonly<Record<string, string>> = {
  digest: 'Digest',
  'aws-signature': 'AWS Signature (SigV4)',
  oauth1: 'OAuth 1.0',
  ntlm: 'NTLM',
  wsse: 'WSSE',
};

/**
 * User-facing reason a gRPC call can't apply this auth, or `null` when the
 * auth type is supported (none / basic / bearer / api-key / oauth2).
 */
export function grpcUnsupportedAuthMessage(auth: { type: string } | undefined): string | null {
  if (!auth || !Object.hasOwn(GRPC_UNSUPPORTED_AUTH, auth.type)) return null;
  const label = GRPC_UNSUPPORTED_AUTH[auth.type];
  return (
    `${label} authentication is not supported for gRPC, and Restura won't send the call ` +
    'without credentials. Use Bearer, Basic, API Key or OAuth 2.0, or set Auth to No Auth ' +
    '(including any folder or collection it inherits from) and add a pre-computed ' +
    'credential as a metadata entry.'
  );
}

/** Aggregate UTF-8 size of metadata keys + values. */
export function grpcMetadataBytes(metadata: Record<string, string>): number {
  const encoder = new TextEncoder();
  let total = 0;
  for (const [key, value] of Object.entries(metadata)) {
    total += encoder.encode(key).length + encoder.encode(value).length;
  }
  return total;
}

/**
 * Why the metadata is too large to send, or `null` when it fits. No per-entry
 * cap — a 2 KB bearer JWT is ordinary — only a total-bytes ceiling
 * (`MAX_GRPC_METADATA_BYTES`), measured in UTF-8. Callers map this to
 * INVALID_ARGUMENT.
 */
export function grpcMetadataSizeError(metadata: Record<string, string>): string | null {
  const total = grpcMetadataBytes(metadata);
  if (total <= MAX_GRPC_METADATA_BYTES) return null;
  return `Total metadata size (${total} bytes) exceeds maximum of ${MAX_GRPC_METADATA_BYTES} bytes`;
}
