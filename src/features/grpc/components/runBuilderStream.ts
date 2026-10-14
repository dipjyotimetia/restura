/**
 * Interactive gRPC stream send for GrpcRequestBuilder (#917). The stream runs
 * through the registry runner (`useRequestRunner().run`) so it gets the same
 * pre-request / test scripts and history entry as unary; the `stream` hooks
 * feed live messages into the panel + console Frames and hand the outbound
 * controls (send / end / cancel) to the invocation bar.
 */
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';
import type { StreamRunHooks } from '@/features/registry/types';
import type { RegistryRunOptions, RegistryRunResult } from '@/features/registry/useRequestRunner';
import { createProtocolConsoleEntry, useConsoleStore } from '@/store/useConsoleStore';
import type { GrpcRequest, GrpcResponse, Request } from '@/types';
import { GrpcStatusCode } from '@/types';

export interface BuilderStreamControl {
  sendMessage: (msg: unknown) => void;
  endStream: () => void;
  cancelStream: () => void;
}

export interface RunBuilderStreamArgs {
  request: GrpcRequest;
  protocolOptions: Record<string, unknown>;
  run: (
    request: Request,
    protocolId: string,
    options?: RegistryRunOptions
  ) => Promise<RegistryRunResult>;
  /** Retry policy — applied to server streams only (client / bidi are user-driven). */
  retryMaxAttempts: number;
  retryDelayMs: number;
  onMessage: (text: string) => void;
  /** Clear previously shown messages before a retry attempt. */
  onReset: () => void;
  setStreamControl: (control: BuilderStreamControl | null) => void;
}

/**
 * Run the stream to completion and resolve with the aggregated response (or
 * reject when the stream could not start). Frames + toasts are emitted here;
 * the caller writes the response to its tab and clears loading state.
 */
export async function runBuilderStream(args: RunBuilderStreamArgs): Promise<GrpcResponse> {
  const { request } = args;
  // Mirror streaming traffic into the unified console Frames tab. One
  // connection id per invocation groups a stream's frames; the label is the
  // called method.
  const streamLabel = `${request.service}/${request.method}`;
  const streamConnId = `grpc-${uuidv4().slice(0, 8)}`;
  const streamFrame = (direction: 'in' | 'out' | 'system', payload: string) =>
    useConsoleStore.getState().addFrame({
      timestamp: Date.now(),
      protocol: 'grpc',
      direction,
      connectionId: streamConnId,
      label: streamLabel,
      payload,
      // System frames are lifecycle markers, not wire payloads — leave
      // `bytes` unset so the UI doesn't show a meaningless size for them.
      ...(direction === 'system' ? {} : { bytes: new TextEncoder().encode(payload).length }),
    });

  const hooks: StreamRunHooks = {
    onOpen: (controls) => {
      streamFrame('system', `stream opened — ${request.methodType}`);
      args.setStreamControl({
        sendMessage: (msg: unknown) => {
          streamFrame('out', typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2));
          void controls.send(msg);
        },
        endStream: () => controls.closeSend(),
        cancelStream: () => controls.cancel(),
      });
    },
    onMessage: (msg) => {
      const text = JSON.stringify(msg, null, 2);
      args.onMessage(text);
      streamFrame('in', text);
    },
  };

  const runOnce = () =>
    args.run(request, 'grpc', { protocolOptions: args.protocolOptions, stream: hooks });

  try {
    let { response, scriptResult } = await runOnce();
    let grpcResponse = response as GrpcResponse;
    if (request.methodType === 'server-streaming') {
      for (
        let attempt = 2;
        attempt <= args.retryMaxAttempts &&
        grpcResponse.grpcStatus !== GrpcStatusCode.OK &&
        grpcResponse.grpcStatus !== GrpcStatusCode.CANCELLED;
        attempt++
      ) {
        if (args.retryDelayMs > 0) await new Promise((r) => setTimeout(r, args.retryDelayMs));
        toast.info(`Retrying... (attempt ${attempt}/${args.retryMaxAttempts})`);
        args.onReset();
        ({ response, scriptResult } = await runOnce());
        grpcResponse = response as GrpcResponse;
      }
    }

    const status = grpcResponse.grpcStatus ?? GrpcStatusCode.UNKNOWN;
    if (status === GrpcStatusCode.OK) {
      streamFrame('system', 'stream completed — OK');
      toast.success('Stream completed');
    } else if (status === GrpcStatusCode.CANCELLED) {
      streamFrame('system', 'stream cancelled');
    } else {
      const description = grpcResponse.grpcStatusText || 'Stream error';
      streamFrame('system', `stream closed — ${status} ${description}`);
      toast.error(`gRPC Error: ${status}`, { description });
    }

    // One console entry per user action carrying the script output (the
    // frames above already carry the wire traffic).
    const scriptLogs = [
      ...(scriptResult?.preRequest?.logs ?? []),
      ...(scriptResult?.test?.logs ?? []),
    ];
    const tests = (scriptResult?.test?.tests ?? []).map((t) => ({
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
        method: streamLabel,
        url: request.url,
        headers: sentMetadata,
        ...(request.message ? { body: request.message } : {}),
        response: grpcResponse,
        ...(scriptLogs.length > 0 && { scriptLogs }),
        ...(tests.length > 0 && { tests }),
      })
    );
    return grpcResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    streamFrame('system', `stream error — ${message}`);
    throw err;
  }
}
