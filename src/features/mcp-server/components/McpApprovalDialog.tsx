/**
 * Approval card for agent tool calls that change or send something. One card
 * at a time (oldest first); the queue length is shown. Closing the dialog
 * (Escape, overlay, X) denies — nothing is ever approved implicitly, and the
 * Approve button is not the initially focused control.
 */

import { Bot, Send, ShieldAlert, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { settleApproval, useMcpServerRuntimeStore } from '../store/useMcpServerRuntimeStore';

const TIER_COPY = {
  edit: {
    verb: 'Apply',
    label: 'wants to change your workspace',
    tone: 'accent' as const,
    icon: Bot,
  },
  destructive: { verb: 'Delete', label: 'wants to delete', tone: 'danger' as const, icon: Trash2 },
  execute: { verb: 'Send', label: 'wants to send a request', tone: 'warning' as const, icon: Send },
  read: { verb: 'Allow', label: 'wants to read', tone: 'accent' as const, icon: Bot },
  ui: { verb: 'Allow', label: 'wants to open a tab', tone: 'accent' as const, icon: Bot },
};

/**
 * Approve stays disabled briefly whenever a new card comes to the front, so a
 * click meant for one card can never land on the next (e.g. when an agent
 * cancels the front card just as the user clicks).
 */
export const APPROVE_ARMING_MS = 600;

export function McpApprovalDialog() {
  const approvals = useMcpServerRuntimeStore((s) => s.approvals);
  const current = approvals[0];
  const [armedFor, setArmedFor] = useState<string | null>(null);
  const callId = current?.callId;
  useEffect(() => {
    if (!callId) return;
    const timer = setTimeout(() => setArmedFor(callId), APPROVE_ARMING_MS);
    return () => clearTimeout(timer);
  }, [callId]);
  if (!current) return null;
  const armed = armedFor === current.callId;
  const copy = TIER_COPY[current.tier];
  const who = current.client ?? 'An MCP agent';

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) settleApproval(current.callId, 'denied');
      }}
    >
      <DialogContent
        className="max-w-lg"
        data-testid="mcp-approval-dialog"
        onOpenAutoFocus={(event) => {
          // Focus Deny, not Approve, so a stray Enter never approves.
          event.preventDefault();
          (document.querySelector('[data-mcp-approval-deny]') as HTMLButtonElement | null)?.focus();
        }}
      >
        <DialogHeader icon={copy.icon} tone={copy.tone}>
          <DialogTitle>{current.title}</DialogTitle>
          <DialogDescription>
            {who} {copy.label} via the Restura MCP server.
          </DialogDescription>
        </DialogHeader>

        {current.details.length > 0 && (
          <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto whitespace-pre-wrap rounded-md border border-sp-line bg-sp-surface-lo p-3 text-sp-12 font-mono text-sp-text break-all">
            {current.details.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}

        {current.tier === 'execute' && (
          <p className="mt-2 flex items-start gap-1.5 text-sp-11-5 text-sp-muted">
            <ShieldAlert size={13} className="mt-0.5 shrink-0 text-amber-500" aria-hidden="true" />
            It is sent with the request&rsquo;s saved credentials and the environment shown above
            (if any). The agent receives the response, with credential headers and token-like fields
            redacted.
          </p>
        )}

        <DialogFooter className="mt-4 flex items-center justify-between gap-2 sm:justify-between">
          <span className="text-sp-11 text-sp-muted">
            {approvals.length > 1 ? `${approvals.length - 1} more waiting` : ' '}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              data-mcp-approval-deny
              onClick={() => settleApproval(current.callId, 'denied')}
            >
              Deny
            </Button>
            <Button
              variant={current.tier === 'destructive' ? 'destructive' : 'default'}
              data-testid="mcp-approval-approve"
              disabled={!armed}
              onClick={() => settleApproval(current.callId, 'approved')}
            >
              {copy.verb}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
