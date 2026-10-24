import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { executeGrpcProxy } from '@shared/protocol/grpc-proxy';
import {
  callKindOf,
  inputFromJson,
  outputToJson,
  registryFromDescriptors,
  registryFromProtoText,
  resolveMethod,
} from '@shared/protocol/grpc-registry';
import {
  grpcMetadataSizeError,
  grpcUnsupportedAuthMessage,
} from '@shared/protocol/grpc-request-policy';
import { GrpcStatusCode, GrpcStatusCodeName } from '@shared/protocol/grpc-status';
import { base64ToBytes, bytesToBase64 } from '@shared/protocol/grpc-web-framing';
import { collectGrpcWebEvents, executeGrpcWebProxy } from '@shared/protocol/grpc-web-proxy';
import type { Fetcher } from '@shared/protocol/types';
import type { GrpcRequest, GrpcSchemaSnapshot } from '@shared/types';
import type { LoadedRequest } from '../collectionLoader';
import { createUndiciFetcher, undiciFetcher } from '../undiciFetcher';
import { resolveVarsDeep } from '../varResolver';
import { applyAuthHeaders, resolveOAuth2Token } from './auth';
import type { ExecuteOptions, ExecuteOutcome } from './types';

/**
 * gRPC executor. Honours the request's pinned `wireProtocol` (#914):
 *  - absent / `connect` → the shared `executeGrpcProxy` (Connect JSON over
 *    HTTP — schema-less, so the persisted `schema` snapshot is unused).
 *  - `grpc-web` / `grpc-web-text` → the shared `executeGrpcWebProxy`, encoding
 *    and decoding protobuf with the request's persisted `schema` snapshot
 *    (reflection descriptors or an uploaded `.proto`, #871). No schema →
 *    FAILED_PRECONDITION, nothing sent.
 *  - `grpc` (native HTTP/2) → refused with UNIMPLEMENTED: the CLI has no h2
 *    transport, and silently downgrading to Connect would test a different
 *    protocol than the one pinned.
 * The CLI's `undiciFetcher` is the same one the HTTP path uses.
 *
 * Pre-flight policy shared with the app (`shared/protocol/grpc-request-policy`):
 * auth types gRPC can't apply (SigV4, OAuth 1.0, WSSE, Digest, NTLM) fail with
 * FAILED_PRECONDITION instead of going out unauthenticated (#900), and
 * metadata over 16 KiB fails with INVALID_ARGUMENT (#895).
 *
 * Only unary methods are supported: the shared proxy is unary-only. Streaming
 * methods (server / client / bidi) fail explicitly rather than silently
 * downgrading to unary, which previously returned partial/incorrect data with
 * no warning in CI.
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
  if (req.methodType && req.methodType !== 'unary') {
    return {
      status: 0,
      passed: false,
      durationMs: 0,
      bodyBytes: 0,
      errorMessage: `The CLI does not support ${req.methodType} gRPC methods yet (unary only). Run streaming methods from the desktop app.`,
    };
  }
  const unsupportedAuth = grpcUnsupportedAuthMessage(req.auth);
  if (unsupportedAuth) {
    return grpcFailure(GrpcStatusCode.FAILED_PRECONDITION, unsupportedAuth);
  }
  if (req.wireProtocol === 'grpc') {
    return grpcFailure(
      GrpcStatusCode.UNIMPLEMENTED,
      'This request is pinned to native gRPC (HTTP/2), which the CLI cannot send yet. ' +
        'Set its wire protocol to Connect or gRPC-Web, or run it from the desktop app.'
    );
  }
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
    // Header-based auth (Bearer / Basic / API-key / OAuth2) → gRPC metadata.
    // gRPC has no query channel, so api-key `in: query` is unsupported here.
    const resolvedAuth = await resolveOAuth2Token(req.auth, opts.vars, {
      allowLocalhost: opts.allowLocalhost,
    });
    applyAuthHeaders(resolvedAuth, metadata, {});
    const metadataError = grpcMetadataSizeError(metadata);
    if (metadataError) return grpcFailure(GrpcStatusCode.INVALID_ARGUMENT, metadataError);

    const fetcher = opts.dispatcher ? createUndiciFetcher(opts.dispatcher) : undiciFetcher;
    if (req.wireProtocol === 'grpc-web' || req.wireProtocol === 'grpc-web-text') {
      return await executeGrpcWeb(req, url, metadata, parsedMessage, fetcher, opts, start);
    }

    const result = await executeGrpcProxy(
      {
        url,
        service: req.service,
        method: req.method,
        metadata,
        message: parsedMessage,
        // Per-request timeout (saved with the request, #921) overrides the
        // global --timeout — same precedence as the HTTP executor.
        timeout: req.timeout ?? opts.timeoutMs,
      },
      fetcher,
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
        responseTrailers: result.response.trailers,
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
      responseHeaders: payload.headers,
      responseTrailers: payload.trailers,
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

function grpcFailure(code: GrpcStatusCode, message: string, durationMs = 0): ExecuteOutcome {
  const name = GrpcStatusCodeName[code] ?? 'UNKNOWN';
  return {
    status: 0,
    passed: false,
    durationMs,
    bodyBytes: 0,
    grpcStatus: { code, message: name },
    errorMessage: `gRPC ${name}: ${message}`,
  };
}

const NO_SCHEMA =
  'gRPC-Web needs the service schema — save the request with a reflection snapshot or an uploaded .proto.';

/** Build a registry from the persisted schema snapshot and resolve the method. */
function methodFromSnapshot(snapshot: GrpcSchemaSnapshot | undefined, req: GrpcRequest) {
  if (!snapshot) throw new Error(NO_SCHEMA);
  const registry =
    snapshot.kind === 'descriptors'
      ? registryFromDescriptors(snapshot.descriptors)
      : registryFromProtoText(snapshot.text, snapshot.fileName);
  return resolveMethod(registry, req.service, req.method).method;
}

/**
 * One unary gRPC-Web call through the shared orchestrator (framing, SSRF,
 * header policy, deadline, size cap, status resolution). Schema-side work —
 * JSON ⇄ protobuf — uses the request's persisted snapshot, as the web app's
 * `makeGrpcWebRequest` does. Unknown request keys are rejected (the shared
 * strict default): CI should fail on a typo rather than send defaults.
 */
async function executeGrpcWeb(
  req: GrpcRequest,
  url: string,
  metadata: Record<string, string>,
  message: unknown,
  fetcher: Fetcher,
  opts: ExecuteOptions,
  start: number
): Promise<ExecuteOutcome> {
  let method: ReturnType<typeof methodFromSnapshot>;
  try {
    method = methodFromSnapshot(req.schema, req);
  } catch (err) {
    return grpcFailure(
      GrpcStatusCode.FAILED_PRECONDITION,
      err instanceof Error ? err.message : String(err)
    );
  }
  if (callKindOf(method) !== 'unary') {
    return grpcFailure(
      GrpcStatusCode.UNIMPLEMENTED,
      `The CLI does not support ${callKindOf(method)} gRPC methods yet (unary only).`
    );
  }
  let encoded: string;
  try {
    const input = inputFromJson(method, message) as Parameters<typeof toBinary>[1];
    encoded = bytesToBase64(toBinary(method.input, input));
  } catch (err) {
    return grpcFailure(
      GrpcStatusCode.INVALID_ARGUMENT,
      err instanceof Error ? err.message : String(err)
    );
  }

  const result = executeGrpcWebProxy(
    {
      url,
      service: req.service,
      method: req.method,
      metadata,
      message: encoded,
      timeout: req.timeout && req.timeout > 0 ? req.timeout : opts.timeoutMs,
      format: req.wireProtocol === 'grpc-web-text' ? 'text' : 'binary',
    },
    fetcher,
    { allowLocalhost: opts.allowLocalhost }
  );
  if (!result.ok) {
    return {
      status: result.status,
      passed: false,
      durationMs: Date.now() - start,
      bodyBytes: 0,
      errorMessage: result.payload.error,
    };
  }
  const onAbort = () => result.cancel();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  let collected: Awaited<ReturnType<typeof collectGrpcWebEvents>>;
  try {
    collected = await collectGrpcWebEvents(result.events);
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
  const durationMs = Date.now() - start;
  let { end } = collected;
  let body: unknown;
  if (end.grpcStatus === GrpcStatusCode.OK) {
    try {
      const first = collected.messages[0];
      body =
        first === undefined
          ? {}
          : outputToJson(method, fromBinary(method.output, base64ToBytes(first)));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      end = {
        ...end,
        grpcStatus: GrpcStatusCode.INTERNAL,
        grpcStatusText: GrpcStatusCodeName[GrpcStatusCode.INTERNAL] ?? 'INTERNAL',
        grpcMessage: `Failed to decode gRPC-Web response message: ${reason}`,
      };
    }
  }
  const passed = end.grpcStatus === GrpcStatusCode.OK;
  return {
    status: passed ? 200 : 500,
    passed,
    durationMs,
    bodyBytes: end.size,
    responseHeaders: collected.headers,
    responseTrailers: end.trailers,
    responseBody: JSON.stringify(passed ? body : { error: end.grpcMessage ?? end.grpcStatusText }),
    grpcStatus: { code: end.grpcStatus, message: end.grpcStatusText },
    ...(passed
      ? {}
      : {
          errorMessage: `gRPC ${end.grpcStatusText}${end.grpcMessage ? `: ${end.grpcMessage}` : ''}`,
        }),
  };
}
