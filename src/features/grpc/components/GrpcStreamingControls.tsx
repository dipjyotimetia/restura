'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { GrpcMethodType } from '@/types';

interface StreamControl {
  sendMessage: (msg: unknown) => void;
  endStream: () => void;
  cancelStream: () => void;
}

interface GrpcStreamingControlsProps {
  streamControl: StreamControl | null;
  methodType: GrpcMethodType;
  onCancel: () => void;
}

export default function GrpcStreamingControls({
  streamControl,
  methodType,
  onCancel,
}: GrpcStreamingControlsProps) {
  const [messageInput, setMessageInput] = useState('{}');
  const [sendError, setSendError] = useState<string | null>(null);

  if (!streamControl) return null;

  const canSendMessages =
    methodType === 'client-streaming' || methodType === 'bidirectional-streaming';

  const handleSend = () => {
    setSendError(null);
    try {
      const parsed = JSON.parse(messageInput);
      streamControl.sendMessage(parsed);
    } catch {
      setSendError('Invalid JSON — message not sent');
    }
  };

  const handleEnd = () => {
    streamControl.endStream();
  };

  return (
    <div className="flex items-center gap-2">
      {canSendMessages && (
        <div className="flex items-center gap-1">
          <Textarea
            value={messageInput}
            onChange={(e) => {
              setMessageInput(e.target.value);
              setSendError(null);
            }}
            placeholder="{}"
            className={`h-7 min-w-[180px] max-w-[260px] resize-none font-mono text-xs py-1 ${sendError ? 'border-destructive' : ''}`}
            rows={1}
            title={sendError ?? 'JSON message to send'}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleSend}
            className="h-7 shrink-0 font-mono text-xs"
            title="Send message to stream"
          >
            Send
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleEnd}
            className="h-7 shrink-0 font-mono text-xs"
            title="End client stream (sends EOF)"
          >
            End
          </Button>
        </div>
      )}
      <Button variant="destructive" size="sm" onClick={onCancel} className="h-7 shrink-0">
        Cancel
      </Button>
    </div>
  );
}

// Component for displaying streaming messages
export function GrpcStreamingMessages({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="text-sm text-muted-foreground mb-2">
        Streaming messages received: {messages.length}
      </div>
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {messages.map((message, index) => (
          <div key={index} className="bg-muted p-2 rounded border border-border">
            <div className="text-xs font-medium mb-1">Message {index + 1}</div>
            <pre className="text-xs whitespace-pre-wrap">{message}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}
