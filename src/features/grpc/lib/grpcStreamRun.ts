/**
 * Run one gRPC stream (server / client / bidi) to completion and aggregate it
 * into a `GrpcResponse` — the transport half of the registry runner's
 * streaming path (#917). Scripts and history live in the protocol module /
 * runner; this only drives `startGrpcStream`.
 *
 * Interactive callers pass `hooks.onOpen` and own outbound sends; without it
 * the request's own message is sent (a top-level JSON array = one message per
 * element) and the outbound side half-closed, which is what a collection run
 * needs.
 */
import { v4 as uuidv4 } from 'uuid';
import type { StreamRunHooks } from '@/features/registry/types';
import type { GrpcRequest, GrpcResponse, GrpcStatusCode } from '@/types';
import { GrpcStatusCodeName } from '@/types';
import { type GrpcStreamFinal, startGrpcStream } from './grpcStreamingClient';

export interface GrpcStreamRunArgs {
  request: GrpcRequest;
  resolveVariables: (text: string) => string;
  signal: AbortSignal;
  hooks?: StreamRunHooks;
  protoContent?: string;
  protoFileName?: string;
  descriptors?: string[];
  timeoutMs?: number;
  useCompression?: boolean;
}

export interface GrpcStreamRunResult {
  response: GrpcResponse;
  /** Inbound messages as parsed JSON (bound to `rs.response.messages`). */
  messages: unknown[];
}

/** Outbound messages for a non-interactive client / bidi stream. */
export function outboundMessages(message: string, resolve: (t: string) => string): unknown[] {
  if (!message.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(resolve(message));
  } catch (err) {
    throw new Error(
      `Invalid JSON in request message: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function runGrpcStreamCall(args: GrpcStreamRunArgs): Promise<GrpcStreamRunResult> {
  const { request, signal, hooks } = args;
  const interactive = !!hooks?.onOpen;
  const isClientSide =
    request.methodType === 'client-streaming' || request.methodType === 'bidirectional-streaming';
  // Parse before opening so a bad body never leaves a half-open stream.
  const outbound =
    !interactive && isClientSide ? outboundMessages(request.message, args.resolveVariables) : [];
  if (signal.aborted) throw new DOMException('Request aborted', 'AbortError');

  const startedAt = Date.now();
  const handle = await startGrpcStream({
    request,
    resolveVariables: args.resolveVariables,
    ...(args.protoContent ? { protoContent: args.protoContent } : {}),
    ...(args.protoFileName ? { protoFileName: args.protoFileName } : {}),
    ...(args.descriptors?.length ? { descriptors: args.descriptors } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args.useCompression !== undefined ? { useCompression: args.useCompression } : {}),
  });

  const onAbort = () => handle.cancel();
  signal.addEventListener('abort', onAbort, { once: true });
  const messages: unknown[] = [];
  try {
    if (interactive) {
      hooks?.onOpen?.({
        send: (m) => handle.send(m),
        closeSend: () => handle.closeSend(),
        cancel: () => handle.cancel(),
      });
    } else if (isClientSide) {
      for (const m of outbound) await handle.send(m);
      handle.closeSend();
    }
    try {
      for await (const msg of handle.messages) {
        messages.push(msg);
        hooks?.onMessage?.(msg);
      }
    } catch {
      // The iterator throws on a non-OK status; `done` always resolves with
      // that status + trailers, which is what the response reports.
    }
    const final = await handle.done;
    return { response: aggregate(request, final, messages, startedAt), messages };
  } catch (err) {
    // A failed send / hook must not leave the call half-open.
    handle.cancel();
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function aggregate(
  request: GrpcRequest,
  final: GrpcStreamFinal,
  messages: unknown[],
  startedAt: number
): GrpcResponse {
  const status = final.status as GrpcStatusCode;
  const statusText = final.statusMessage || GrpcStatusCodeName[status] || 'UNKNOWN';
  const messageStrs = messages.map((m) => JSON.stringify(m));
  // A client stream answers with exactly one message — show it as the body.
  const bodyValue =
    request.methodType === 'client-streaming' && messages.length === 1
      ? messages[0]
      : messages.length === 0 && status !== 0
        ? { error: statusText }
        : messages;
  const body = JSON.stringify(bodyValue, null, 2);
  return {
    id: uuidv4(),
    requestId: request.id,
    status,
    statusText,
    headers: final.headers,
    body,
    size: new Blob([body]).size,
    time: Date.now() - startedAt,
    timestamp: Date.now(),
    grpcStatus: status,
    grpcStatusText: statusText,
    trailers: final.trailers,
    messages: messageStrs,
    isStreaming: true,
    ...(final.statusDetails?.length ? { statusDetails: final.statusDetails } : {}),
  };
}
