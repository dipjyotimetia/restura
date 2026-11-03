import type { RequestExecutionResult } from './requestExecutor';

/**
 * Tell a Collection run that the transport failed (no response came back), so
 * it can never be scored a pass. A `skipRequest()` placeholder is not a failure.
 */
export function reportTransportError(
  result: Pick<RequestExecutionResult, 'transportOk' | 'response' | 'scriptResult'>,
  ctx: { onTransportError?: ((message: string) => void) | undefined }
): void {
  if (result.transportOk || !ctx.onTransportError) return;
  if (result.scriptResult?.preRequest?.execution?.skipRequested) return;
  ctx.onTransportError(result.response.body || result.response.statusText || 'Request failed');
}
