/**
 * gRPC protocol module.
 *
 * Drives **unary** gRPC calls through the registry runner. Streaming
 * (server / client / bidi) is intentionally out of scope — see the
 * TODO(registry-streaming) note below — so the GrpcRequestBuilder keeps
 * its bespoke wiring for those paths via `startElectronGrpcStream`.
 *
 * Two transport branches:
 *  - Electron: full reflection support, requires proto content. The
 *    builder loads proto bytes (uploaded file or reflection-generated)
 *    and passes them via `ctx.protocolOptions.protoContent` /
 *    `protoFileName`. Without those the run errors out with a clear
 *    message rather than silently degrading to the proxy.
 *  - Web: routed through the worker `/api/grpc` proxy which accepts the
 *    request shape directly (no proto needed — the worker uses gRPC-Web
 *    framing).
 *
 * Pre-request and test scripts run inline here so the registry-side seam
 * matches HTTP — `executeRequest` does the same for HTTP. Builders that
 * call `useRequestRunner().run(grpcReq, 'grpc')` get scripts + history +
 * Console panel updates without re-implementing the pipeline.
 */
import { v4 as uuidv4 } from 'uuid';
import type { ProtocolModule } from '@/features/registry/types';
import type {
  GrpcRequest,
  GrpcResponse,
  Response as ApiResponse,
} from '@/types';
import {
  makeProxyGrpcRequest,
  makeElectronGrpcRequest,
} from './lib/grpcClient';
import ScriptExecutor from '@/features/scripts/lib/scriptExecutor';
import type { ScriptResult } from '@/features/scripts/lib/scriptExecutor';
import { isElectron } from '@/lib/shared/platform';

function createDefaultGrpcRequest(): GrpcRequest {
  return {
    id: uuidv4(),
    name: 'New gRPC Request',
    type: 'grpc',
    methodType: 'unary',
    url: '',
    service: '',
    method: '',
    metadata: [],
    message: '',
    auth: { type: 'none' },
  };
}

function defaultResolveVariables(
  text: string,
  vars: Record<string, string>
): string {
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }
  return result;
}

interface GrpcProtocolOptions {
  /** Raw proto file contents (required for Electron unary). */
  protoContent?: string;
  /** Proto file name for Electron logging / cache keying. */
  protoFileName?: string;
  /** Per-request timeout override in ms (defaults to 30s). */
  timeoutMs?: number;
  /** Send gzip-compressed payloads (Electron only — web path ignores). */
  useCompression?: boolean;
}

function readProtocolOptions(
  raw: Record<string, unknown> | undefined
): GrpcProtocolOptions {
  if (!raw) return {};
  const out: GrpcProtocolOptions = {};
  if (typeof raw.protoContent === 'string') out.protoContent = raw.protoContent;
  if (typeof raw.protoFileName === 'string') out.protoFileName = raw.protoFileName;
  if (typeof raw.timeoutMs === 'number') out.timeoutMs = raw.timeoutMs;
  if (typeof raw.useCompression === 'boolean') out.useCompression = raw.useCompression;
  return out;
}

export const grpcProtocol: ProtocolModule = {
  id: 'grpc',
  label: 'gRPC',
  tabType: 'grpc',
  defaultRequest: createDefaultGrpcRequest,
  // Builder is intentionally undefined — GrpcRequestBuilder remains
  // mounted by the route. It calls `useRequestRunner` for unary and
  // talks to startElectronGrpcStream directly for streaming methods.
  runRequest: async (request, ctx): Promise<ApiResponse> => {
    if (request.type !== 'grpc') {
      throw new Error(`gRPC protocol cannot run ${request.type} request`);
    }
    if (request.methodType !== 'unary') {
      // TODO(registry-streaming): server / client / bidirectional streams
      // need an iterator-shaped contract on RunContext. Until then the
      // builder owns these paths via startElectronGrpcStream.
      throw new Error(
        `gRPC ${request.methodType} requires the streaming pipeline; use startElectronGrpcStream, not the registry runner.`
      );
    }
    if (ctx.signal.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }

    const variables = ctx.variables ?? {};
    const resolve = (text: string) => defaultResolveVariables(text, variables);
    const opts = readProtocolOptions(ctx.protocolOptions);
    const timeoutMs = opts.timeoutMs ?? 30000;

    // Pre-request script — populated env vars merge into the script-side
    // sandbox only (we don't mutate the parent caller's `variables` map).
    const scriptEnvVars: Record<string, string> = { ...variables };
    let preRequestResult: ScriptResult | undefined;
    if (request.preRequestScript?.trim()) {
      const executor = new ScriptExecutor(scriptEnvVars, {});
      preRequestResult = await executor.executeScript(request.preRequestScript, {
        request: {
          url: request.url,
          method: request.methodType,
          headers: {},
          body: request.message,
        },
      });
      if (preRequestResult.variables) {
        Object.assign(scriptEnvVars, preRequestResult.variables);
      }
    }

    let response: GrpcResponse;
    if (isElectron()) {
      if (!opts.protoContent || !opts.protoFileName) {
        throw new Error(
          'gRPC Electron unary requires `protoContent` and `protoFileName` via protocolOptions.'
        );
      }
      response = await makeElectronGrpcRequest(
        request,
        opts.protoContent,
        opts.protoFileName,
        resolve,
        timeoutMs,
        opts.useCompression ?? false
      );
    } else {
      response = await makeProxyGrpcRequest(request, resolve, timeoutMs);
    }

    // Test script — receives the response so users can assert on
    // grpcStatus, body, headers, etc.
    let testResult: ScriptResult | undefined;
    if (request.testScript?.trim()) {
      const executor = new ScriptExecutor(scriptEnvVars, {});
      testResult = await executor.executeScript(request.testScript, {
        request: {
          url: request.url,
          method: request.methodType,
          headers: {},
          body: request.message,
        },
        response: {
          status: response.grpcStatus ?? 0,
          statusText: response.grpcStatusText ?? '',
          headers: {},
          body: response.body,
          time: response.time,
          size: response.size,
        },
      });
    }

    if (ctx.onScriptResult && (preRequestResult || testResult)) {
      const result: { preRequest?: ScriptResult; test?: ScriptResult } = {};
      if (preRequestResult) result.preRequest = preRequestResult;
      if (testResult) result.test = testResult;
      ctx.onScriptResult(result);
    }

    return response;
  },
};
