import type { LoadedRequest } from '../collectionLoader';
import { executeGrpc } from './grpc';
import { executeHttp } from './http';
import { executeMcp } from './mcp';
import { executeSse } from './sse';
import type { ExecuteOptions, ExecuteOutcome } from './types';
import { executeWebSocket } from './websocket';

/**
 * Route a loaded request to the executor for its protocol. Each executor
 * returns the same `ExecuteOutcome` shape so the runner does not need to
 * know which protocol it ran. Script execution and assertion handling
 * happens in the runner around this call.
 */
export async function executeRequest(
  item: LoadedRequest,
  opts: ExecuteOptions
): Promise<ExecuteOutcome> {
  // Each executor runs `preflightRefusal` first (blocked at load, unresolvable
  // variables), so the refusal holds for every caller, not only this router.
  switch (item.type) {
    case 'http':
      return executeHttp(item, opts);
    case 'grpc':
      return executeGrpc(item, opts);
    case 'sse':
      return executeSse(item, opts);
    case 'mcp':
      return executeMcp(item, opts);
  }
}

export { executeWebSocket };
