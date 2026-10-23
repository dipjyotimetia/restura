import { useEffect } from 'react';
import { subscribeMcpClientRequests } from '@/features/mcp/lib/mcpClientRequests';
import type { McpConnectionStatus } from '@/features/mcp/store/useMcpStore';

/**
 * Listen for server→client requests (#860) while a desktop session is opening
 * or open. The subscription (and any prompts still queued for the connection)
 * is torn down on disconnect, error, connection switch and unmount, so
 * listeners never leak across sessions.
 */
export function useMcpClientRequests(
  connectionId: string | undefined,
  status: McpConnectionStatus | undefined
): void {
  const live = status === 'connecting' || status === 'connected';
  useEffect(() => {
    if (!connectionId || !live) return;
    return subscribeMcpClientRequests(connectionId);
  }, [connectionId, live]);
}
