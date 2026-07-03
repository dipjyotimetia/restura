import type { PmExecutionLocation, PmRequestInfo } from './scriptExecutor';

/**
 * Collection-runner context threaded through `ctx.protocolOptions` —
 * `pm.collectionVariables` / `pm.iterationData` / `pm.info` /
 * `pm.execution.location`. Shared by every protocol module's
 * `protocolOptions` narrowing so the shape only needs to be validated once;
 * each module spreads the result and layers its own protocol-specific
 * fields (e.g. gRPC's `protoContent`) on top.
 */
export interface PmRunContextOptions {
  collectionVars?: Record<string, string>;
  iterationData?: Record<string, string>;
  info?: Pick<PmRequestInfo, 'iteration' | 'iterationCount'>;
  location?: PmExecutionLocation;
}

export function readPmRunContextOptions(
  raw: Record<string, unknown> | undefined
): PmRunContextOptions {
  if (!raw) return {};
  const out: PmRunContextOptions = {};
  if (raw.collectionVars && typeof raw.collectionVars === 'object') {
    out.collectionVars = raw.collectionVars as Record<string, string>;
  }
  if (raw.iterationData && typeof raw.iterationData === 'object') {
    out.iterationData = raw.iterationData as Record<string, string>;
  }
  if (raw.info && typeof raw.info === 'object') {
    out.info = raw.info as Pick<PmRequestInfo, 'iteration' | 'iterationCount'>;
  }
  if (raw.location && typeof raw.location === 'object') {
    out.location = raw.location as PmExecutionLocation;
  }
  return out;
}
