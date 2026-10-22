/**
 * Browser-persistence gate for MCP credentials (#896, SEC-3).
 *
 * On web, Zustand stores persist to IndexedDB without an OS-keychain-wrapped
 * key, so a token typed into an MCP connection would sit there in plaintext.
 * These helpers run inside store `partialize` and blank MCP credential values
 * on the web harness only; the in-memory state keeps them for the session.
 * Desktop persistence is encrypted (keychain-wrapped key) and passes through.
 */
import {
  redactMcpCollectionCredentials,
  redactMcpCredentials,
} from '@shared/secrets/mcp-credential-redaction';
import { isElectron } from '@/lib/shared/platform';
import type { Collection, Request } from '@/types';

export function redactMcpRequestForWebPersistence(request: Request): Request {
  if (request.type !== 'mcp' || isElectron()) return request;
  return redactMcpCredentials(request);
}

export function redactMcpCollectionsForWebPersistence(collections: Collection[]): Collection[] {
  if (isElectron()) return collections;
  return collections.map(redactMcpCollectionCredentials);
}
