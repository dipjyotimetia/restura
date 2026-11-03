/**
 * The user types a secret an agent asked for (`request_secret_variable`).
 * The value goes straight into the environment as a secret variable and is
 * never returned to the agent. The agent's `reason` is shown as quoted,
 * untrusted text.
 */

import { KeyRound } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { settleSecretPrompt, useMcpServerRuntimeStore } from '../store/useMcpServerRuntimeStore';

export function McpSecretPromptDialog() {
  const prompts = useMcpServerRuntimeStore((s) => s.secretPrompts);
  const current = prompts[0];
  const [value, setValue] = useState('');

  // Never carry a typed value over to the next prompt.
  useEffect(() => {
    setValue('');
  }, [current?.callId]);

  if (!current) return null;
  const decline = () => settleSecretPrompt(current.callId, null);

  return (
    <Dialog open onOpenChange={(open) => !open && decline()}>
      <DialogContent className="max-w-md" data-testid="mcp-secret-dialog">
        <DialogHeader icon={KeyRound} tone="warning">
          <DialogTitle>Set secret “{current.key}”</DialogTitle>
          <DialogDescription>
            {current.client ?? 'An MCP agent'} needs a secret in environment “
            {current.environmentName}”. The agent will not see the value — only that it was set.
          </DialogDescription>
        </DialogHeader>
        <blockquote className="mt-2 border-l-2 border-sp-line pl-3 text-sp-12 text-sp-muted break-words">
          Agent&rsquo;s reason: {current.reason}
        </blockquote>
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (value.length > 0) settleSecretPrompt(current.callId, value);
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            aria-label={`Value for ${current.key}`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
          <DialogFooter className="mt-4 gap-2">
            <Button type="button" variant="outline" onClick={decline}>
              Decline
            </Button>
            <Button type="submit" disabled={value.length === 0}>
              Save secret
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
