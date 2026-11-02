/**
 * gRPC protocol module.
 *
 * Drives every gRPC call type through the registry runner. Unary calls
 * resolve to the single response; server / client / bidi streams run via
 * `runGrpcStreamCall` (#917) — `runRequest` resolves once the stream ends,
 * with an aggregated response (all messages, metadata, trailers, final
 * status), and `ctx.stream` hooks let the interactive builder watch and
 * drive the stream meanwhile. So streams get the same pre-request / test
 * scripts, history entries and collection-runner support as unary.
 *
 * Two unary transport branches (streams use `startGrpcStream` on both):
 *  - Electron: needs a schema — reflection `descriptors` or uploaded
 *    `protoContent` / `protoFileName` via `ctx.protocolOptions` (the
 *    builder passes its live state; the collection runner passes the
 *    request's persisted `schema` snapshot). Without either it falls back
 *    to server reflection, and fails with an actionable error when that is
 *    unavailable rather than silently degrading to the proxy.
 *  - Web: routed through the worker `/api/grpc` proxy as schema-less
 *    Connect JSON by default; when the request's `wireProtocol` is
 *    `grpc-web` / `grpc-web-text` it goes through `/api/grpc-web` instead,
 *    encoded with the schema (descriptors / proto text / saved snapshot).
 *
 * Pre-request and test scripts run inline here so the registry-side seam
 * matches HTTP — `executeRequest` does the same for HTTP. Builders that
 * call `useRequestRunner().run(grpcReq, 'grpc')` get scripts + history +
 * Console panel updates without re-implementing the pipeline.
 */
import {
  applyScriptMetadata,
  findScriptWrittenToken,
  grpcMetadataForScript,
} from '@shared/scripts/grpc-script-metadata';
import { SecretVariableReferenceError } from '@shared/variables/secret-variable-token';
import { v4 as uuidv4 } from 'uuid';
import type { ProtocolModule } from '@/features/registry/types';
import { makeCookieAdapter } from '@/features/scripts/lib/pmCookieAdapter.renderer';
import type { PmRunContextOptions } from '@/features/scripts/lib/pmRunContextOptions';
import {
  readPmRunContextOptions,
  skippedPlaceholderResponse,
} from '@/features/scripts/lib/pmRunContextOptions';
import { makeRendererSendRequest } from '@/features/scripts/lib/pmSendRequestHost';
import type { ScriptResult } from '@/features/scripts/lib/scriptExecutor';
import ScriptExecutor from '@/features/scripts/lib/scriptExecutor';
import { injectString } from '@/features/workflows/lib/variableHelpers';
import { applyVarMutations } from '@/lib/shared/collectionVarMutations';
import { escapeRegExp } from '@/lib/shared/escapeRegExp';
import { makeRendererJudge } from '@/lib/shared/judgeBridge';
import { isElectron } from '@/lib/shared/platform';
import { resolveMapText } from '@/lib/shared/resolveRequestScope';
import { makeVaultAdapter } from '@/lib/shared/vaultClient';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { Response as ApiResponse, GrpcRequest, GrpcResponse, Request } from '@/types';
import { makeElectronGrpcRequest, makeProxyGrpcRequest } from './lib/grpcClient';
import { reflectionCredentialsFor } from './lib/grpcReflection';
import { discoverDescriptorsForRequest } from './lib/grpcSchemaSnapshot';
import { runGrpcStreamCall } from './lib/grpcStreamRun';
import { isGrpcWebWire, makeGrpcWebRequest } from './lib/grpcWebClient';
import { applyUnknownFieldPolicy, schemaSourceFromSnapshot } from './lib/unknownFields';

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

function injectGrpcVariables(
  request: Request,
  variables: Record<string, string>,
  secretNames?: readonly string[]
): Request {
  if (request.type !== 'grpc') return request;
  const grpc = request as GrpcRequest;
  const inject = (text: string) => injectString(text, variables, secretNames);
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

type ScriptInfo = NonNullable<GrpcProtocolOptions['info']> & {
  requestName: string;
  requestId: string;
};

/**
 * What a script sees for one metadata value. A reference that would be refused
 * stays as written here: the script may yet skip the request or replace the value,
 * and the send path decides after it has run.
 */
function scriptViewText(
  text: string,
  vars: Record<string, string>,
  secretNames: readonly string[] | undefined
): string {
  try {
    return resolveMapText(text, vars, secretNames, defaultResolveVariables);
  } catch (error) {
    if (error instanceof SecretVariableReferenceError) return text;
    throw error;
  }
}

/** Request view bound into scripts: `rs.request.metadata` (aliased as `headers`). */
function scriptRequestContext(
  request: GrpcRequest,
  vars: Record<string, string>,
  secretNames: readonly string[] | undefined
) {
  const metadata = grpcMetadataForScript(request.metadata, (t) =>
    scriptViewText(t, vars, secretNames)
  );
  return {
    url: request.url,
    method: request.methodType,
    headers: metadata,
    metadata,
    body: request.message,
  };
}

function makeScriptExecutor(
  scriptEnvVars: Record<string, string>,
  opts: GrpcProtocolOptions,
  info: ScriptInfo & { eventName: 'prerequest' | 'test' },
  withJudge: boolean,
  secretNames: readonly string[] | undefined
): ScriptExecutor {
  const judgeCfg = withJudge ? useSettingsStore.getState().settings.judge : undefined;
  return new ScriptExecutor({
    envVars: scriptEnvVars,
    globalVars: useGlobalsStore.getState().vars,
    collectionVars: { ...(opts.collectionVars ?? {}) },
    iterationData: { ...(opts.iterationData ?? {}) },
    info,
    ...(opts.location ? { location: opts.location } : {}),
    host: {
      sendRequest: makeRendererSendRequest({
        variables: scriptEnvVars,
        ...(secretNames ? { secretNames } : {}),
        inheritedHeaders: {},
      }),
      cookies: (currentUrl) => makeCookieAdapter(currentUrl),
      vault: makeVaultAdapter(),
      ...(judgeCfg?.enabled ? { judge: makeRendererJudge(judgeCfg) } : {}),
    },
  });
}

/**
 * Run the pre-request script (if any). Returns the script-side variable map,
 * the result, and the request with any `rs.request.metadata` edits folded in
 * (#910) — callers send THAT request, not the original.
 */
async function runGrpcPreRequestScript(
  request: GrpcRequest,
  variables: Record<string, string>,
  opts: GrpcProtocolOptions,
  secretNames: readonly string[] | undefined
): Promise<{
  request: GrpcRequest;
  scriptEnvVars: Record<string, string>;
  scriptInfo: ScriptInfo;
  preRequestResult?: ScriptResult;
}> {
  const scriptEnvVars: Record<string, string> = { ...variables };
  const scriptInfo: ScriptInfo = {
    requestName: request.name,
    requestId: request.id,
    ...opts.info,
  };
  if (!request.preRequestScript?.trim()) return { request, scriptEnvVars, scriptInfo };

  const executor = makeScriptExecutor(
    scriptEnvVars,
    opts,
    { ...scriptInfo, eventName: 'prerequest' },
    false,
    secretNames
  );
  const preRequestResult = await executor.executeScript(request.preRequestScript, {
    request: scriptRequestContext(request, variables, secretNames),
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
  const skipping = opts.honorSkipRequest && preRequestResult.execution?.skipRequested;
  if (preRequestResult.requestMetadata && !skipping) {
    const written = findScriptWrittenToken(
      request.metadata,
      preRequestResult.requestMetadata,
      (name) => secretNames?.includes(name) === true
    );
    if (written) {
      throw new SecretVariableReferenceError(
        'rs.request.metadata',
        written.name,
        `"${written.key}"`,
        'A script cannot add a secret variable to a request field.'
      );
    }
  }
  const next = preRequestResult.requestMetadata
    ? {
        ...request,
        metadata: applyScriptMetadata(request.metadata, preRequestResult.requestMetadata, (t) =>
          scriptViewText(t, variables, secretNames)
        ),
      }
    : request;
  return { request: next, scriptEnvVars, scriptInfo, preRequestResult };
}

/** Scripts see a flat metadata map; repeated keys join with ", " (Fetch semantics). */
function joinMultiValued(
  headers: Record<string, string | string[]> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/** Run the test script (if any) against the response, metadata + trailers included. */
async function runGrpcTestScript(
  request: GrpcRequest,
  response: GrpcResponse,
  streamMessages: unknown[] | undefined,
  scriptEnvVars: Record<string, string>,
  scriptInfo: ScriptInfo,
  opts: GrpcProtocolOptions,
  secretNames: readonly string[] | undefined
): Promise<ScriptResult | undefined> {
  if (!request.testScript?.trim()) return undefined;
  const executor = makeScriptExecutor(
    scriptEnvVars,
    opts,
    { ...scriptInfo, eventName: 'test' },
    true,
    secretNames
  );
  const testResult = await executor.executeScript(request.testScript, {
    request: scriptRequestContext(request, scriptEnvVars, secretNames),
    response: {
      status: response.grpcStatus ?? 0,
      statusText: response.grpcStatusText ?? '',
      headers: joinMultiValued(response.headers),
      trailers: response.trailers ?? {},
      // Streams: every inbound message, parsed (`rs.response.messages`).
      ...(streamMessages ? { messages: streamMessages } : {}),
      body: response.body,
      time: response.time,
      size: response.size,
      ...(response.statusDetails ? { statusDetails: response.statusDetails } : {}),
    },
  });
  if (testResult.globalsMutations) {
    useGlobalsStore.getState().applyMutations(testResult.globalsMutations);
  }
  return testResult;
}

export const grpcProtocol: ProtocolModule = {
  id: 'grpc',
  label: 'gRPC',
  tabType: 'grpc',
  defaultRequest: createDefaultGrpcRequest,
  injectVariables: injectGrpcVariables,
  // Builder is intentionally undefined — GrpcRequestBuilder remains
  // mounted by the route and calls `useRequestRunner` for every call type
  // (streams pass `stream` hooks for live messages + outbound controls).
  runRequest: async (rawRequest, ctx): Promise<ApiResponse> => {
    if (rawRequest.type !== 'grpc') {
      throw new Error(`gRPC protocol cannot run ${rawRequest.type} request`);
    }
    let request: GrpcRequest = rawRequest;
    if (ctx.signal.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }

    const variables = ctx.variables ?? {};
    const opts = readProtocolOptions(ctx.protocolOptions);
    // Streams: 0 = no deadline (kept). Unary: always a positive deadline.
    const timeoutMs =
      request.methodType !== 'unary' && opts.timeoutMs === 0
        ? 0
        : opts.timeoutMs && opts.timeoutMs > 0
          ? opts.timeoutMs
          : 30000;

    // Pre-request script — populated env vars merge into the script-side
    // sandbox only (we don't mutate the parent caller's `variables` map).
    const pre = await runGrpcPreRequestScript(request, variables, opts, ctx.secretNames);
    const { scriptEnvVars, scriptInfo, preRequestResult } = pre;
    request = pre.request;

    // `pm.execution.skipRequest()` in a Collection run: nothing is sent and no
    // test script runs.
    if (opts.honorSkipRequest && preRequestResult?.execution?.skipRequested) {
      ctx.onScriptResult?.({ preRequest: preRequestResult });
      return skippedPlaceholderResponse(request.id);
    }

    let response: GrpcResponse;
    let streamMessages: unknown[] | undefined;
    const resolve = (text: string) =>
      resolveMapText(text, scriptEnvVars, ctx.secretNames, defaultResolveVariables);
    // Electron needs a schema; a request without one (e.g. a saved request run
    // from a collection with no snapshot) falls back to server reflection,
    // which throws an actionable error ("reflect or upload a .proto").
    let descriptors = opts.descriptors?.length ? opts.descriptors : undefined;
    if (isElectron() && !descriptors && (!opts.protoContent || !opts.protoFileName)) {
      descriptors = await discoverDescriptorsForRequest(
        resolve(request.url),
        request.service,
        reflectionCredentialsFor(request, resolve)
      );
    }
    const isStream = request.methodType !== 'unary';
    // #925 / #944: unary request keys are checked before anything is sent —
    // refused (block) or stripped (warn / off). On web the message is relayed
    // as JSON, so this is the only place a typo is caught. Only authoritative
    // schemas count: descriptors or the saved snapshot, never the lossy
    // `.proto` text reconstructed from reflection. Streams apply the same
    // policy per message inside the streaming client.
    const policy: ReturnType<typeof applyUnknownFieldPolicy> = isStream
      ? { request }
      : applyUnknownFieldPolicy(
          request,
          descriptors ? { descriptors } : schemaSourceFromSnapshot(request.schema),
          resolve
        );
    if (isStream) {
      ({ response, messages: streamMessages } = await runGrpcStreamCall({
        request,
        resolveVariables: resolve,
        signal: ctx.signal,
        ...(ctx.stream ? { hooks: ctx.stream } : {}),
        ...(opts.protoContent ? { protoContent: opts.protoContent } : {}),
        ...(opts.protoFileName ? { protoFileName: opts.protoFileName } : {}),
        ...(descriptors ? { descriptors } : {}),
        timeoutMs,
        ...(opts.useCompression !== undefined ? { useCompression: opts.useCompression } : {}),
      }));
    } else if (policy.refused) {
      response = policy.refused;
    } else if (isElectron()) {
      response = await makeElectronGrpcRequest(
        policy.request,
        opts.protoContent ?? '',
        opts.protoFileName ?? 'generated.proto',
        resolve,
        timeoutMs,
        opts.useCompression ?? false,
        descriptors
      );
    } else if (isGrpcWebWire(request.wireProtocol)) {
      // gRPC-Web through the Worker's /api/grpc-web relay — needs the schema
      // to encode/decode protobuf (live builder state or the saved snapshot).
      response = await makeGrpcWebRequest(policy.request, resolve, timeoutMs, {
        ...(descriptors?.length ? { descriptors } : {}),
        ...(opts.protoContent ? { protoContent: opts.protoContent } : {}),
      });
    } else {
      response = await makeProxyGrpcRequest(policy.request, resolve, timeoutMs);
    }

    // Test script — receives the response so users can assert on
    // grpcStatus, body, response metadata (headers) and trailers.
    const testResult = await runGrpcTestScript(
      request,
      response,
      streamMessages,
      scriptEnvVars,
      scriptInfo,
      opts,
      ctx.secretNames
    );

    if (ctx.onScriptResult && (preRequestResult || testResult)) {
      const result: { preRequest?: ScriptResult; test?: ScriptResult } = {};
      if (preRequestResult) result.preRequest = preRequestResult;
      if (testResult) result.test = testResult;
      ctx.onScriptResult(result);
    }

    return response;
  },
};
