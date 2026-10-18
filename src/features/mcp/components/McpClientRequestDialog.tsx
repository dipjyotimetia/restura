import { Bot, ClipboardList } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { McpElicitationPrompt } from '@/features/mcp/components/McpElicitationPrompt';
import { McpSamplingPrompt } from '@/features/mcp/components/McpSamplingPrompt';
import { respondToElicitation, respondToSampling } from '@/features/mcp/lib/mcpClientRequests';
import { useMcpClientRequestStore } from '@/features/mcp/store/useMcpClientRequestStore';

interface McpClientRequestDialogProps {
  connectionId: string;
}

/**
 * Shows the oldest pending server→client request for the connection (#860).
 * Dismissing the dialog is an explicit answer: `cancel` for elicitation,
 * `reject` for sampling — a prompt is never silently left open or approved.
 */
export function McpClientRequestDialog({ connectionId }: McpClientRequestDialogProps) {
  const queue = useMcpClientRequestStore(
    useShallow((state) => state.requests.filter((request) => request.connectionId === connectionId))
  );
  const request = queue[0];
  if (!request) return null;

  const isElicitation = request.kind === 'elicitation';
  const dismiss = () => {
    if (isElicitation) void respondToElicitation(request, { action: 'cancel' });
    else void respondToSampling(request, { action: 'reject' });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader icon={isElicitation ? ClipboardList : Bot} tone="warning">
          <DialogTitle>
            {isElicitation ? 'MCP server requests input' : 'MCP server requests a model response'}
          </DialogTitle>
          <DialogDescription>
            {isElicitation
              ? 'Review the request and choose what to share with the server.'
              : 'The server asked the client to sample an LLM. Nothing is sent without your approval.'}
            {queue.length > 1 ? ` (${queue.length - 1} more waiting)` : ''}
          </DialogDescription>
        </DialogHeader>
        {isElicitation ? (
          <McpElicitationPrompt
            key={request.requestId}
            params={request.params}
            onRespond={(response) => respondToElicitation(request, response)}
          />
        ) : (
          <McpSamplingPrompt
            key={request.requestId}
            params={request.params}
            onRespond={(response) => respondToSampling(request, response)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
