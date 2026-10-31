// Desktop `a2a` tool source: remote A2A agents reached through the SAME request
// executor the app uses (main-process SSRF guard, DNS checks, proxy and TLS
// settings), never a parallel HTTP path. Calls are `network` class, so every
// call needs approval unless the suite's policy profile auto-approves network.

import type { AgentToolSourceAdapter } from '@shared/agent-lab';
import { type A2aTransport, createA2aToolSourceAdapter } from '@shared/agent-lab';
import { executeExtractedRequest } from './execCell';

export const desktopA2aTransport: A2aTransport = async (request, signal) => {
  const result = await executeExtractedRequest(
    {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body ?? '',
    },
    signal
  );
  signal?.throwIfAborted();
  // The executor reports transport failures as a synthetic status-0 response.
  if (result.status === 0)
    throw new Error(`A2A request failed: ${result.body || result.statusText}`);
  return { status: result.status, body: result.body };
};

export function createDesktopA2aToolSourceAdapter(
  transport: A2aTransport = desktopA2aTransport
): AgentToolSourceAdapter {
  return createA2aToolSourceAdapter(transport);
}
