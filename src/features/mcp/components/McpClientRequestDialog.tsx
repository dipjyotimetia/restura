import { Bot, ClipboardList, ShieldAlert } from 'lucide-react';
import { useRef } from 'react';
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
  /** Who is asking: shown so a prompt can't pass itself off as Restura or another server. */
  connectionName: string;
  /** Host of the (resolved) server URL. */
  serverHost: string;
  /**
   * stdio: the (resolved) command of the local server process. When set, the
   * prompt names the process instead of a URL host — a stdio connection has no
   * URL, and the request's leftover HTTP URL would name the wrong server.
   */
  localCommand?: string | undefined;
}

/** Host of a server URL for display; falls back to the raw string. */
export function displayHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * Shows the oldest pending server→client request for the connection (#860).
 * Dismissing the dialog is an explicit answer: `cancel` for elicitation,
 * `reject` for sampling — a prompt is never silently left open or approved.
 */
export function McpClientRequestDialog({
  connectionId,
  connectionName,
  serverHost,
  localCommand,
}: McpClientRequestDialogProps) {
  const queue = useMcpClientRequestStore(
    useShallow((state) => state.requests.filter((request) => request.connectionId === connectionId))
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const request = queue[0];
  if (!request) return null;

  const isElicitation = request.kind === 'elicitation';
  const recipient =
    localCommand !== undefined ? `the local process ${localCommand || '(no command)'}` : serverHost;
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
      <DialogContent
        key={request.requestId}
        ref={contentRef}
        className="max-w-xl"
        // Land on the safe action (Decline / Reject), never in a field or on Accept.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.querySelector<HTMLElement>('[data-mcp-autofocus]')?.focus();
        }}
      >
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
        <p className="font-mono text-sp-12 text-sp-muted break-all">
          Connection: <span className="text-sp-text">{connectionName}</span> (
          {localCommand !== undefined ? `local process ${localCommand}` : serverHost})
        </p>
        {/* Fixed client-authored warning — never server-controlled text. */}
        <div
          role="note"
          className="flex items-start gap-2 rounded-sp-btn border px-3 py-2 text-sp-12"
          style={{
            color: 'var(--color-warning)',
            background: 'color-mix(in srgb, var(--color-warning) 8%, transparent)',
            borderColor: 'color-mix(in srgb, var(--color-warning) 25%, transparent)',
          }}
        >
          <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          <span>Anything you enter is sent to {recipient}. Never enter passwords or API keys.</span>
        </div>
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
