import { Code2 } from 'lucide-react';
import { useState } from 'react';
import { ProtocolCodeDialog } from '@/components/shared/ProtocolCodeDialog';
import { websocketCodeGenerators } from '@/lib/shared/codeGenerators/websocket';
import type { KeyValue } from '@/types';

/** "Code" for a WebSocket connection: browser JavaScript / Python / Node.js. */
export function WebSocketCodeDialog({
  open,
  onOpenChange,
  url,
  protocols,
  headers,
  sampleMessage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string;
  protocols: readonly string[];
  headers: readonly KeyValue[];
  sampleMessage?: string;
}) {
  const enabledHeaders = Object.fromEntries(
    headers.filter((h) => h.enabled && h.key.trim()).map((h) => [h.key.trim(), h.value])
  );
  return (
    <ProtocolCodeDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Generate WebSocket client code"
      description="Uses the connection options as typed: {{variables}} stay unresolved. Browsers cannot send custom handshake headers, so only the Node.js snippet includes them."
      generators={websocketCodeGenerators}
      options={{
        url,
        ...(protocols.length > 0 ? { protocols: [...protocols] } : {}),
        ...(Object.keys(enabledHeaders).length > 0 ? { headers: enabledHeaders } : {}),
        ...(sampleMessage?.trim() ? { sampleMessage } : {}),
      }}
    />
  );
}

/** Icon button in the connection bar that opens {@link WebSocketCodeDialog}. */
export function WebSocketCodeButton(props: {
  url: string;
  protocols: readonly string[];
  headers: readonly KeyValue[];
  sampleMessage?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Generate code"
        title="Generate client code for this connection"
        className="h-7 w-7 inline-flex items-center justify-center shrink-0 rounded-sp-btn text-sp-muted hover:text-sp-text hover:bg-sp-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
      >
        <Code2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <WebSocketCodeDialog open={open} onOpenChange={setOpen} {...props} />
    </>
  );
}
