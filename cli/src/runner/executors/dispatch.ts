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
  // Refused at load time (see `LoadedRequest.blocked`): never executed, for
  // every protocol and every caller.
  if (item.blocked) {
    return { status: 0, passed: false, durationMs: 0, bodyBytes: 0, errorMessage: item.blocked };
  }
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
