import { resolveUrlHostnameSafe } from '../security/dns-guard';
import { getExecutionPolicy } from '../security/execution-policy';

const GRPC_ALLOWED_SCHEMES = ['http:', 'https:', 'grpc:', 'grpcs:'];

export interface PinnedDial {
  ip: string;
  port: number;
  family: 4 | 6;
}

/** Resolve and validate a direct gRPC destination, then pin the selected IP. */
export async function resolveGrpcDialAddress(url: string): Promise<PinnedDial> {
  const records = await resolveUrlHostnameSafe(url, {
    ...getExecutionPolicy().security,
    allowedSchemes: GRPC_ALLOWED_SCHEMES,
  });
  const chosen = records[0];
  if (!chosen) throw new Error(`DNS resolution returned no records for ${new URL(url).hostname}`);
  const parsed = new URL(url);
  const useTls = parsed.protocol === 'https:' || parsed.protocol === 'grpcs:';
  return {
    ip: chosen.address,
    port: parsed.port ? Number(parsed.port) : useTls ? 443 : 80,
    family: chosen.family === 6 ? 6 : 4,
  };
}

/** Dial metadata for a CONNECT route where the proxy resolves the destination. */
export function unresolvedGrpcProxyDialAddress(url: string): PinnedDial {
  const parsed = new URL(url);
  const useTls = parsed.protocol === 'https:' || parsed.protocol === 'grpcs:';
  return {
    ip: '0.0.0.0',
    port: parsed.port ? Number(parsed.port) : useTls ? 443 : 80,
    family: 4,
  };
}
