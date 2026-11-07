import { ProtocolCodeDialog } from '@/components/shared/ProtocolCodeDialog';
import { sseCodeGenerators } from '@/lib/shared/codeGenerators/sse';
import type { SseRequest } from '@/types';

/** "Code" for an SSE stream: EventSource / fetch stream / cURL. */
export function SseCodeDialog({
  open,
  onOpenChange,
  request,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: SseRequest;
}) {
  return (
    <ProtocolCodeDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Generate SSE client code"
      description="Uses the Headers entries as typed: {{variables}} stay unresolved and Auth-tab credentials are not included."
      generators={sseCodeGenerators}
      options={{ request }}
    />
  );
}
