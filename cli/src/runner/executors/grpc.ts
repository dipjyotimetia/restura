import { executeGrpcProxy } from '@shared/protocol/grpc-proxy';
import type { GrpcRequest } from '@/types';
import { undiciFetcher } from '../undiciFetcher';
import { resolveVarsDeep } from '../varResolver';
import type { LoadedRequest } from '../collectionLoader';
import type { ExecuteOptions, ExecuteOutcome } from './types';

/**
 * gRPC executor. Uses the shared `executeGrpcProxy` which speaks the Connect
 * protocol over HTTP — no protobuf compilation needed at runtime since Connect
 * carries JSON-shaped payloads. The CLI's `undiciFetcher` is the same one the
 * HTTP path uses; gRPC just sets specific headers and rides on top.
 *
 * Streaming methods (server / client / bidi) fall back to unary semantics for
 * the CLI v0.2 — the shared proxy does not yet stream-buffer.
 */
export async function executeGrpc(
  item: LoadedRequest,
  opts: ExecuteOptions
): Promise<ExecuteOutcome> {
  if (item.type !== 'grpc') {
    return {
      status: 0,
      passed: false,
      durationMs: 0,
      bodyBytes: 0,
      errorMessage: `gRPC executor received non-grpc request: ${item.type}`,
    };
  }
  const req = item.request as GrpcRequest;
  const url = resolveVarsDeep(req.url, opts.vars);
  const metadata: Record<string, string> = {};
  for (const m of req.metadata ?? []) {
    if (m.enabled && m.key) metadata[m.key] = resolveVarsDeep(m.value, opts.vars);
  }
  const message = req.message ? resolveVarsDeep(req.message, opts.vars) : '';
  let parsedMessage: unknown = {};
  if (message.trim().length > 0) {
    try {
      parsedMessage = JSON.parse(message);
    } catch (err) {
      return {
        status: 0,
        passed: false,
        durationMs: 0,
        bodyBytes: 0,
        errorMessage: `Invalid gRPC message JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const start = Date.now();
  try {
    const result = await executeGrpcProxy(
      {
        url,
        service: req.service,
        method: req.method,
        metadata,
        message: parsedMessage,
        timeout: opts.timeoutMs,
      },
      undiciFetcher,
      { allowLocalhost: opts.allowLocalhost }
    );
    const durationMs = Date.now() - start;

    if (result.ok) {
      const grpcCode = result.response.grpcStatus;
      const passed = grpcCode === 0; // gRPC OK
      return {
        status: passed ? 200 : 500,
        passed,
        durationMs,
        bodyBytes: result.response.size,
        responseHeaders: result.response.headers,
        responseBody:
          typeof result.response.data === 'string'
            ? result.response.data
            : JSON.stringify(result.response.data),
        grpcStatus: { code: grpcCode, message: result.response.grpcStatusText },
        ...(passed ? {} : { errorMessage: `gRPC ${result.response.grpcStatusText}` }),
      };
    }
    const payload = result.payload;
    if ('error' in payload) {
      return {
        status: result.status,
        passed: false,
        durationMs,
        bodyBytes: 0,
        errorMessage: payload.error,
      };
    }
    return {
      status: result.status,
      passed: false,
      durationMs,
      bodyBytes: payload.size,
      grpcStatus: { code: payload.grpcStatus, message: payload.grpcStatusText },
      errorMessage: `gRPC ${payload.grpcStatusText}`,
    };
  } catch (err) {
    return {
      status: 0,
      passed: false,
      durationMs: Date.now() - start,
      bodyBytes: 0,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
