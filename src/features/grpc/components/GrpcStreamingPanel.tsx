import { useEffect, useRef, useState } from 'react';
import type { GrpcRequest } from '@/types';
import { startGrpcStream, type GrpcStreamingHandle } from '../lib/grpcStreamingClient';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { Button } from '@/components/ui/button';
import { Square, Play, Send, StopCircle } from 'lucide-react';

export interface GrpcStreamingPanelProps {
  request: GrpcRequest;
  protoContent?: string;
  protoFileName?: string;
}

type Status = 'idle' | 'streaming' | 'closed' | 'error';

const MAX_MESSAGES = 500;

const isInteractive = (methodType: GrpcRequest['methodType']) =>
  methodType === 'client-streaming' || methodType === 'bidirectional-streaming';

export function GrpcStreamingPanel({ request, protoContent, protoFileName }: GrpcStreamingPanelProps) {
  const [messages, setMessages] = useState<unknown[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [outboundDraft, setOutboundDraft] = useState('{}');
  const [draftError, setDraftError] = useState<string | null>(null);
  const [sendEnded, setSendEnded] = useState(false);
  const handleRef = useRef<GrpcStreamingHandle | null>(null);
  const resolveVariables = useEnvironmentStore((s) => s.resolveVariables);

  const start = async () => {
    setMessages([]);
    setError(null);
    setDraftError(null);
    setSendEnded(false);
    setStatus('streaming');
    try {
      const handle = await startGrpcStream({ request, resolveVariables, protoContent, protoFileName });
      handleRef.current = handle;

      void (async () => {
        try {
          for await (const msg of handle.messages) {
            setMessages((prev) => {
              const next = [...prev, msg];
              return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
            });
          }
          await handle.done;
          setStatus((cur) => (cur === 'error' ? cur : 'closed'));
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Stream failed');
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
  };

  const end = () => {
    handleRef.current?.closeSend();
    setSendEnded(true);
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
      : status === 'error'
        ? 'Error'
        : status === 'closed'
          ? 'Closed'
          : 'Idle';

  const interactive = isInteractive(request.methodType);
  const streaming = status === 'streaming';

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
        <span className="text-muted-foreground">{messages.length} messages</span>
        <div className="flex-1" />
        {!streaming && (
          <Button size="sm" variant="default" onClick={start} aria-label="start stream">
            <Play className="size-4" />
            <span className="ml-1">Start</span>
          </Button>
        )}
        {streaming && (
          <Button
            size="sm"
            variant="destructive"
            onClick={cancel}
            aria-label="cancel stream"
          >
            <Square className="size-4" />
            <span className="ml-1">Cancel</span>
          </Button>
        )}
      </div>

      {interactive && streaming && (
        <div className="border-b px-3 py-2 space-y-2">
          <label className="text-xs text-muted-foreground" htmlFor="streaming-message-input">
            Outbound message
          </label>
          <textarea
            id="streaming-message-input"
            aria-label="Streaming message JSON"
            className="w-full font-mono text-xs border rounded p-2 resize-none bg-background min-h-[60px] focus:outline-none focus:ring-1 focus:ring-ring"
            value={outboundDraft}
            onChange={(e) => setOutboundDraft(e.target.value)}
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
              disabled={sendEnded}
              aria-label="send message"
            >
              <Send className="size-3 mr-1" />
              Send
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={end}
              disabled={sendEnded}
              aria-label="end outbound stream"
            >
              <StopCircle className="size-3 mr-1" />
              End
            </Button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 font-mono text-xs space-y-2">
        {messages.map((msg, i) => (
          <div key={i} className="border-b border-border/30 pb-2 last:border-b-0">
            <div className="text-muted-foreground text-[10px] mb-1">#{i + 1}</div>
            <pre className="whitespace-pre-wrap break-all">{JSON.stringify(msg, null, 2)}</pre>
          </div>
        ))}
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
