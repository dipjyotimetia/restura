import type { CollectionItem, Request } from '../../shared/types';
import { isTabRequest } from '../../shared/types';

/**
 * Test helper: the tab request (HTTP / gRPC / SSE / MCP) saved on `item`.
 * Throws for a missing request or a Kafka / MQTT connection preset (#984),
 * so a test never reads `auth` / `url` off a preset by accident.
 */
export function requestOf(item: CollectionItem | undefined): Request {
  const request = item?.request;
  if (!isTabRequest(request)) {
    throw new Error(`expected a tab request on item "${item?.name ?? '<missing>'}"`);
  }
  return request;
}
