'use client';

import { Button } from '@/components/ui/button';

interface StreamControl {
  sendMessage: (msg: unknown) => void;
  endStream: () => void;
  cancelStream: () => void;
}

interface GrpcStreamingControlsProps {
  streamControl: StreamControl | null;
  onCancel: () => void;
}

export default function GrpcStreamingControls({
  streamControl,
  onCancel,
}: GrpcStreamingControlsProps) {
  if (!streamControl) return null;

  return (
    <Button
      variant="destructive"
      onClick={onCancel}
    >
      Cancel Stream
    </Button>
  );
}

// Component for displaying streaming messages
export function GrpcStreamingMessages({
  messages,
}: {
  messages: string[];
}) {
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
