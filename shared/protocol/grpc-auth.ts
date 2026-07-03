/**
 * Auth types gRPC cannot apply credentials for, on either platform. HTTP has
 * real signers for these — aws-signature/oauth1/wsse via
 * `shared/protocol/auth-signer.ts`, digest/ntlm via their own downstream
 * handling — but gRPC's metadata-based transport has no equivalent, whether
 * the request is built in the renderer (`grpcClient.ts`'s `buildAuthMetadata`,
 * used on both platforms) or resolved main-side for SecretRef-handle
 * credentials (`electron/main/security/auth-applier.ts`). Single source of
 * truth so those two callers can't drift on which types these are.
 */
export const GRPC_UNSUPPORTED_AUTH_TYPES: ReadonlySet<string> = new Set([
  'digest',
  'oauth1',
  'aws-signature',
  'ntlm',
  'wsse',
]);
