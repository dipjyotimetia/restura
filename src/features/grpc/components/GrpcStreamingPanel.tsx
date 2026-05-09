import { useEffect, useRef, useState } from 'react';
import type { GrpcRequest } from '@/types';
import { startGrpcStream, type GrpcStreamingHandle } from '../lib/grpcStreamingClient';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { Button } from '@/components/ui/button';
import { Square, Play } from 'lucide-react';

export interface GrpcStreamingPanelProps {
  request: GrpcRequest;
}

type Status = 'idle' | 'streaming' | 'closed' | 'error';

export function GrpcStreamingPanel({ request }: GrpcStreamingPanelProps) {
  const [messages, setMessages] = useState<unknown[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const handleRef = useRef<GrpcStreamingHandle | null>(null);
  const resolveVariables = useEnvironmentStore((s) => s.resolveVariables);

  const start = async () => {
    setMessages([]);
    setError(null);
    setStatus('streaming');
    try {
      const handle = await startGrpcStream({ request, resolveVariables });
      handleRef.current = handle;

      // Drain messages in the background.
      void (async () => {
        try {
          for await (const msg of handle.messages) {
            setMessages((prev) => [...prev, msg]);
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

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 border-b px-3 py-2 text-sm">
        <span
          className={[
            'flex items-center gap-1.5',
            status === 'streaming'
              ? 'text-green-600'
              : status === 'error'
                ? 'text-red-600'
                : 'text-muted-foreground',
          ].join(' ')}
        >
          <span
            className={[
              'inline-block size-2 rounded-full',
              status === 'streaming'
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
        {status !== 'streaming' && (
          <Button size="sm" variant="default" onClick={start} aria-label="start stream">
            <Play className="size-4" />
            <span className="ml-1">Start</span>
          </Button>
        )}
        {status === 'streaming' && (
          <Button size="sm" variant="destructive" onClick={cancel} aria-label="cancel stream">
            <Square className="size-4" />
            <span className="ml-1">Cancel</span>
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 font-mono text-xs space-y-2">
        {messages.map((msg, i) => (
          <div key={i} className="border-b border-border/30 pb-2 last:border-b-0">
            <div className="text-muted-foreground text-[10px] mb-1">#{i + 1}</div>
            <pre className="whitespace-pre-wrap break-all">{JSON.stringify(msg, null, 2)}</pre>
          </div>
        ))}
        {error && (
          <div className="text-red-600 border-l-2 border-red-600 pl-2 py-1">{error}</div>
        )}
      </div>
    </div>
  );
}

export default GrpcStreamingPanel;
