/**
 * gRPC protocol module.
 *
 * Drives **unary** gRPC calls through the registry runner. Streaming
 * (server / client / bidi) is intentionally out of scope — see the
 * TODO(registry-streaming) note below — so the GrpcRequestBuilder keeps
 * its bespoke wiring for those paths via `startGrpcStream`.
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
import { makeCookieAdapter } from '@/features/scripts/lib/pmCookieAdapter.renderer';
import type { PmRunContextOptions } from '@/features/scripts/lib/pmRunContextOptions';
import { readPmRunContextOptions } from '@/features/scripts/lib/pmRunContextOptions';
import { makeRendererSendRequest } from '@/features/scripts/lib/pmSendRequestHost';
import type { ScriptResult } from '@/features/scripts/lib/scriptExecutor';
import ScriptExecutor from '@/features/scripts/lib/scriptExecutor';
import { injectString } from '@/features/workflows/lib/variableHelpers';
import { applyVarMutations } from '@/lib/shared/collectionVarMutations';
import { escapeRegExp } from '@/lib/shared/escapeRegExp';
import { makeRendererJudge } from '@/lib/shared/judgeBridge';
import { isElectron } from '@/lib/shared/platform';
import { makeVaultAdapter } from '@/lib/shared/vaultClient';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { Response as ApiResponse, GrpcRequest, GrpcResponse, Request } from '@/types';
import { makeElectronGrpcRequest, makeProxyGrpcRequest } from './lib/grpcClient';

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

function defaultResolveVariables(text: string, vars: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`{{${escapeRegExp(key)}}}`, 'g'), () => value);
  }
  return result;
}

interface GrpcProtocolOptions extends PmRunContextOptions {
  /** Raw proto file contents (uploaded `.proto`; or reconstructed fallback). */
  protoContent?: string;
  /** Proto file name for Electron logging / cache keying. */
  protoFileName?: string;
  /** Base64 binary FileDescriptorProtos from reflection (preferred, lossless). */
  descriptors?: string[];
  /** Per-request timeout override in ms (defaults to 30s). */
  timeoutMs?: number;
  /** Send gzip-compressed payloads (Electron only — web path ignores). */
  useCompression?: boolean;
}

function readProtocolOptions(raw: Record<string, unknown> | undefined): GrpcProtocolOptions {
  if (!raw) return {};
  const out: GrpcProtocolOptions = readPmRunContextOptions(raw);
  if (typeof raw.protoContent === 'string') out.protoContent = raw.protoContent;
  if (typeof raw.protoFileName === 'string') out.protoFileName = raw.protoFileName;
  if (Array.isArray(raw.descriptors) && raw.descriptors.every((d) => typeof d === 'string')) {
    out.descriptors = raw.descriptors as string[];
  }
  if (typeof raw.timeoutMs === 'number') out.timeoutMs = raw.timeoutMs;
  if (typeof raw.useCompression === 'boolean') out.useCompression = raw.useCompression;
  return out;
}

function injectGrpcVariables(request: Request, variables: Record<string, string>): Request {
  if (request.type !== 'grpc') return request;
  const grpc = request as GrpcRequest;
  const inject = (text: string) => injectString(text, variables);
  return {
    ...grpc,
    url: inject(grpc.url),
    service: inject(grpc.service),
    method: inject(grpc.method),
    metadata: grpc.metadata.map((m) => ({
      ...m,
      key: inject(m.key),
      value: inject(m.value),
    })),
    // `message` is a JSON string the user authored — substitute into it as
    // a string. We don't try to parse / pretty-print / re-serialise it
    // because that would round-trip-break things like trailing commas or
    // comments the user may have typed (and which the gRPC client tolerates).
    message: inject(grpc.message),
  };
}

export const grpcProtocol: ProtocolModule = {
  id: 'grpc',
  label: 'gRPC',
  tabType: 'grpc',
  defaultRequest: createDefaultGrpcRequest,
  injectVariables: injectGrpcVariables,
  // Builder is intentionally undefined — GrpcRequestBuilder remains
  // mounted by the route. It calls `useRequestRunner` for unary and
  // talks to startGrpcStream directly for streaming methods.
  runRequest: async (request, ctx): Promise<ApiResponse> => {
    if (request.type !== 'grpc') {
      throw new Error(`gRPC protocol cannot run ${request.type} request`);
    }
    if (request.methodType !== 'unary') {
      // TODO(registry-streaming): server / client / bidirectional streams
      // need an iterator-shaped contract on RunContext. Until then the
      // builder owns these paths via startGrpcStream.
      throw new Error(
        `gRPC ${request.methodType} requires the streaming pipeline; use startGrpcStream, not the registry runner.`
      );
    }
    if (ctx.signal.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }

    const variables = ctx.variables ?? {};
    const opts = readProtocolOptions(ctx.protocolOptions);
    const timeoutMs = opts.timeoutMs ?? 30000;

    // Pre-request script — populated env vars merge into the script-side
    // sandbox only (we don't mutate the parent caller's `variables` map).
    const scriptEnvVars: Record<string, string> = { ...variables };
    const scriptInfo = { requestName: request.name, requestId: request.id, ...opts.info };
    let preRequestResult: ScriptResult | undefined;
    if (request.preRequestScript?.trim()) {
      const globalVars = useGlobalsStore.getState().vars;
      const executor = new ScriptExecutor({
        envVars: scriptEnvVars,
        globalVars,
        collectionVars: { ...(opts.collectionVars ?? {}) },
        iterationData: { ...(opts.iterationData ?? {}) },
        info: { ...scriptInfo, eventName: 'prerequest' },
        ...(opts.location ? { location: opts.location } : {}),
        host: {
          sendRequest: makeRendererSendRequest({ variables: scriptEnvVars, inheritedHeaders: {} }),
          cookies: (currentUrl) => makeCookieAdapter(currentUrl),
          vault: makeVaultAdapter(),
        },
      });
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
      if (preRequestResult.collectionMutations) {
        applyVarMutations(scriptEnvVars, preRequestResult.collectionMutations);
      }
      if (preRequestResult.globalsMutations) {
        useGlobalsStore.getState().applyMutations(preRequestResult.globalsMutations);
      }
    }

    let response: GrpcResponse;
    const resolve = (text: string) => defaultResolveVariables(text, scriptEnvVars);
    if (isElectron()) {
      const hasDescriptors = !!opts.descriptors && opts.descriptors.length > 0;
      if (!hasDescriptors && (!opts.protoContent || !opts.protoFileName)) {
        throw new Error(
          'gRPC Electron unary requires reflection `descriptors` or `protoContent` + `protoFileName` via protocolOptions.'
        );
      }
      response = await makeElectronGrpcRequest(
        request,
        opts.protoContent ?? '',
        opts.protoFileName ?? 'generated.proto',
        resolve,
        timeoutMs,
        opts.useCompression ?? false,
        opts.descriptors
      );
    } else {
      response = await makeProxyGrpcRequest(request, resolve, timeoutMs);
    }

    // Test script — receives the response so users can assert on
    // grpcStatus, body, headers, etc.
    const judgeCfg = useSettingsStore.getState().settings.judge;
    let testResult: ScriptResult | undefined;
    if (request.testScript?.trim()) {
      const globalVars = useGlobalsStore.getState().vars;
      const executor = new ScriptExecutor({
        envVars: scriptEnvVars,
        globalVars,
        collectionVars: { ...(opts.collectionVars ?? {}) },
        iterationData: { ...(opts.iterationData ?? {}) },
        info: { ...scriptInfo, eventName: 'test' },
        ...(opts.location ? { location: opts.location } : {}),
        host: {
          sendRequest: makeRendererSendRequest({ variables: scriptEnvVars, inheritedHeaders: {} }),
          cookies: (currentUrl) => makeCookieAdapter(currentUrl),
          vault: makeVaultAdapter(),
          ...(judgeCfg?.enabled ? { judge: makeRendererJudge(judgeCfg) } : {}),
        },
      });
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
      if (testResult.globalsMutations) {
        useGlobalsStore.getState().applyMutations(testResult.globalsMutations);
      }
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
