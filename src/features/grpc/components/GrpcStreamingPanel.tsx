import { Square, Play, Send, StopCircle, ArrowDown, ArrowUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { startGrpcStream, type GrpcStreamingHandle } from '../lib/grpcStreamingClient';
import { Button } from '@/components/ui/button';
import { useConsoleStore } from '@/store/useConsoleStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { GrpcStatusCodeName } from '@/types';
import type { GrpcRequest, GrpcStatusCode } from '@/types';

export interface GrpcStreamingPanelProps {
  request: GrpcRequest;
  protoContent?: string;
  protoFileName?: string;
  /** Lossless reflection descriptors — preferred over the reconstructed proto text. */
  descriptors?: string[];
}

type Status = 'idle' | 'streaming' | 'awaiting-response' | 'closed' | 'error';

interface FrameEntry {
  direction: 'in' | 'out';
  payload: unknown;
  timestamp: number;
}

const MAX_MESSAGES = 500;

const isInteractive = (methodType: GrpcRequest['methodType']) =>
  methodType === 'client-streaming' || methodType === 'bidirectional-streaming';

const isClientStream = (methodType: GrpcRequest['methodType']) => methodType === 'client-streaming';

export function GrpcStreamingPanel({
  request,
  protoContent,
  protoFileName,
  descriptors,
}: GrpcStreamingPanelProps) {
  const [frames, setFrames] = useState<FrameEntry[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [outboundDraft, setOutboundDraft] = useState('{}');
  const [draftError, setDraftError] = useState<string | null>(null);
  const [sendEnded, setSendEnded] = useState(false);
  const handleRef = useRef<GrpcStreamingHandle | null>(null);
  // Stream connection id for the unified console — one per Start so a single
  // invocation's frames group together in the Frames tab. Lives in a ref
  // because send()/the inbound loop run after start() returns.
  const streamConnIdRef = useRef<string>('');
  const resolveVariables = useEnvironmentStore((s) => s.resolveVariables);

  const clientStream = isClientStream(request.methodType);
  const interactive = isInteractive(request.methodType);

  const pushFrame = (direction: FrameEntry['direction'], payload: unknown) => {
    setFrames((prev) => {
      const next = [...prev, { direction, payload, timestamp: Date.now() }];
      return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
    });
  };

  // Mirror streaming traffic into the unified console Frames tab so web gRPC
  // streams show up alongside the desktop path (GrpcRequestBuilder) and the
  // other streaming protocols. Same connection id + method label conventions.
  const streamFrame = (direction: 'in' | 'out' | 'system', payload: string) =>
    useConsoleStore.getState().addFrame({
      timestamp: Date.now(),
      protocol: 'grpc',
      direction,
      connectionId: streamConnIdRef.current,
      label: `${request.service}/${request.method}`,
      payload,
      bytes: new TextEncoder().encode(payload).length,
    });

  const start = async () => {
    setFrames([]);
    setError(null);
    setDraftError(null);
    setSendEnded(false);
    setStatus('streaming');
    streamConnIdRef.current = `grpc-${uuidv4().slice(0, 8)}`;
    try {
      const handle = await startGrpcStream({
        request,
        resolveVariables,
        protoContent,
        protoFileName,
        ...(descriptors?.length ? { descriptors } : {}),
      });
      handleRef.current = handle;
      streamFrame('system', `stream opened — ${request.methodType}`);

      void (async () => {
        try {
          for await (const msg of handle.messages) {
            pushFrame('in', msg);
            streamFrame('in', JSON.stringify(msg, null, 2));
            if (clientStream) {
              // Client-streaming returns a single response after closeSend(); once we
              // get it the call is effectively done.
              setStatus('closed');
            }
          }
          const final = await handle.done;
          if (final.status === 0) {
            streamFrame('system', 'stream completed — OK');
          } else {
            const description =
              final.statusMessage ||
              GrpcStatusCodeName[final.status as GrpcStatusCode] ||
              'Stream error';
            streamFrame('system', `stream closed — ${final.status} ${description}`);
          }
          setStatus((cur) => (cur === 'error' ? cur : 'closed'));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Stream failed';
          streamFrame('system', `stream error — ${message}`);
          setError(message);
          setStatus('error');
        }
      })();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start stream');
      setStatus('error');
    }
  };

  const send = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(outboundDraft);
      setDraftError(null);
    } catch {
      setDraftError('Invalid JSON — fix before sending');
      return;
    }
    handleRef.current?.send(parsed);
    pushFrame('out', parsed);
    streamFrame('out', JSON.stringify(parsed, null, 2));
  };

  const end = () => {
    handleRef.current?.closeSend();
    setSendEnded(true);
    if (clientStream) {
      // Client-streaming: after EOF, the server has up to one reply remaining.
      setStatus('awaiting-response');
    }
  };

  const cancel = () => {
    handleRef.current?.cancel();
    setStatus('closed');
  };

  useEffect(() => {
    return () => {
      handleRef.current?.cancel();
    };
  }, []);

  const statusLabel =
    status === 'streaming'
      ? 'Streaming'
      : status === 'awaiting-response'
        ? 'Awaiting response'
        : status === 'error'
          ? 'Error'
          : status === 'closed'
            ? 'Closed'
            : 'Idle';

  const streaming = status === 'streaming' || status === 'awaiting-response';
  // `awaiting-response` only applies to client-streaming — after closeSend()
  // outbound is finished, but the call is still alive waiting for the single
  // server response. So we only accept new sends while the stream is active.
  const sendAllowed = status === 'streaming' && !sendEnded;
  const inboundCount = frames.filter((f) => f.direction === 'in').length;
  const outboundCount = frames.filter((f) => f.direction === 'out').length;

  return (
    <div className="flex flex-col h-full" aria-label="gRPC streaming panel">
      <div className="flex items-center gap-3 border-b px-3 py-2 text-sm">
        <span
          className={[
            'flex items-center gap-1.5',
            streaming
              ? 'text-green-600'
              : status === 'error'
                ? 'text-red-600'
                : 'text-muted-foreground',
          ].join(' ')}
        >
          <span
            className={[
              'inline-block size-2 rounded-full',
              streaming
                ? 'bg-green-500 animate-pulse'
                : status === 'error'
                  ? 'bg-red-500'
                  : 'bg-muted-foreground',
            ].join(' ')}
          />
          {statusLabel}
        </span>
        <span
          className="text-muted-foreground inline-flex items-center gap-1"
          aria-label="received message count"
        >
          <ArrowDown className="size-3" />
          {inboundCount}
        </span>
        {interactive && (
          <span
            className="text-muted-foreground inline-flex items-center gap-1"
            aria-label="sent message count"
          >
            <ArrowUp className="size-3" />
            {outboundCount}
          </span>
        )}
        <div className="flex-1" />
        {!streaming && (
          <Button size="sm" variant="default" onClick={start} aria-label="start stream">
            <Play className="size-4" />
            <span className="ml-1">Start</span>
          </Button>
        )}
        {streaming && (
          <Button size="sm" variant="destructive" onClick={cancel} aria-label="cancel stream">
            <Square className="size-4" />
            <span className="ml-1">Cancel</span>
          </Button>
        )}
      </div>

      {interactive && streaming && (
        <div className="border-b px-3 py-2 space-y-2">
          <label className="text-xs text-muted-foreground" htmlFor="streaming-message-input">
            Outbound message
            {clientStream && sendEnded && (
              <span className="ml-2 italic">— send closed, waiting for server reply</span>
            )}
          </label>
          <textarea
            id="streaming-message-input"
            aria-label="Streaming message JSON"
            className="w-full font-mono text-xs border rounded p-2 resize-none bg-background min-h-[60px] focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            value={outboundDraft}
            onChange={(e) => setOutboundDraft(e.target.value)}
            disabled={!sendAllowed}
            rows={3}
          />
          {draftError && (
            <p role="alert" className="text-xs text-red-600">
              {draftError}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={send}
              disabled={!sendAllowed}
              aria-label="send message"
            >
              <Send className="size-3 mr-1" />
              Send
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={end}
              disabled={!sendAllowed}
              aria-label="end outbound stream"
            >
              <StopCircle className="size-3 mr-1" />
              {clientStream ? 'Done sending' : 'End'}
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 font-mono text-xs space-y-2">
        {frames.length === 0 && status !== 'error' && (
          <div className="text-muted-foreground italic">
            {interactive
              ? 'No frames yet. Click Start, then send a message.'
              : 'No messages yet. Click Start.'}
          </div>
        )}
        {frames.map((frame, i) => {
          const outbound = frame.direction === 'out';
          return (
            <div
              key={i}
              className={[
                'border-b border-border/30 pb-2 last:border-b-0',
                outbound ? 'pl-2 border-l-2 border-l-blue-500/50' : '',
              ].join(' ')}
              data-direction={frame.direction}
              data-testid={`grpc-frame-${frame.direction}`}
            >
              <div className="text-muted-foreground text-[10px] mb-1 flex items-center gap-1">
                {outbound ? (
                  <>
                    <ArrowUp className="size-2.5" />
                    <span>Sent #{i + 1}</span>
                  </>
                ) : (
                  <>
                    <ArrowDown className="size-2.5" />
                    <span>Received #{i + 1}</span>
                  </>
                )}
              </div>
              <pre className="whitespace-pre-wrap break-all">
                {JSON.stringify(frame.payload, null, 2)}
              </pre>
            </div>
          );
        })}
        {error && (
          <div role="alert" className="text-red-600 border-l-2 border-red-600 pl-2 py-1">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

export default GrpcStreamingPanel;
