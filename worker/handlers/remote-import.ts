import { fetchRemoteImport } from '@shared/import/remote-fetch';
import type { Context } from 'hono';
import { z } from 'zod';
import type { NodeHostnameGuard } from '../adapters';
import type { Env } from '../env';
import { parseJsonBody } from '../shared/validate-body';

const RemoteImportSchema = z.object({ url: z.string().min(1).max(2048) });

/** Fetch a public import artifact. This route deliberately does not reuse the
 * general proxy surface: callers cannot choose headers, auth, proxy, timeout,
 * private-network policy, or response streaming. */
export function createRemoteImportHandler(
  nodeHostnameGuard?: NodeHostnameGuard,
  fetcher: typeof fetch = fetch
) {
  return async function remoteImportHandler(c: Context<{ Bindings: Env }>) {
    const parsed = await parseJsonBody(c.req.raw, RemoteImportSchema, { maxBytes: 4096 });
    if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
    try {
      const result = await fetchRemoteImport(parsed.value.url, {
        fetcher,
        guard: nodeHostnameGuard
          ? async (hostname) => {
              await nodeHostnameGuard(hostname, { allowLocalhost: false, allowPrivateIPs: false });
            }
          : undefined,
      });
      return c.json(result);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Remote import failed.' },
        400
      );
    }
  };
}
