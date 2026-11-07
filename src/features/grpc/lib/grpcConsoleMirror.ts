import type { ProtocolScriptResult } from '@/features/registry/types';
import { createProtocolConsoleEntry, useConsoleStore } from '@/store/useConsoleStore';
import type { GrpcRequest, GrpcResponse } from '@/types';

/**
 * Mirror an interactive unary call into the unified console (interactive
 * sends previously only appeared when run via a collection). Callers mirror
 * the final attempt only — one entry per user action.
 */
export function mirrorGrpcCallToConsole(
  request: GrpcRequest,
  response: GrpcResponse,
  scriptResult: ProtocolScriptResult | undefined
): void {
  const consoleLogs = [
    ...(scriptResult?.preRequest?.logs ?? []),
    ...(scriptResult?.test?.logs ?? []),
  ];
  const consoleTests = (scriptResult?.test?.tests ?? []).map((t) => ({
    name: t.name,
    passed: t.passed,
    ...(t.error ? { error: t.error } : {}),
  }));
  const sentMetadata: Record<string, string> = {};
  for (const m of request.metadata) {
    if (m.enabled && m.key) sentMetadata[m.key] = m.value;
  }
  useConsoleStore.getState().addEntry(
    createProtocolConsoleEntry({
      protocol: 'grpc',
      method: `${request.service}/${request.method}`,
      url: request.url,
      headers: sentMetadata,
      ...(request.message ? { body: request.message } : {}),
      response,
      ...(consoleLogs.length > 0 && { scriptLogs: consoleLogs }),
      ...(consoleTests.length > 0 && { tests: consoleTests }),
      nativeDraft: {
        kind: 'grpc',
        credentialsOmitted: true,
        url: request.url,
        service: request.service,
        method: request.method,
        message: request.message,
        metadata: sentMetadata,
      },
    })
  );
}
