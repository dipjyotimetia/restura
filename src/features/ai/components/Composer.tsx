import { type KeyboardEvent, useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { modLabel } from '@/lib/shared/shortcuts';

interface Props {
  disabled?: boolean;
  streaming?: boolean;
  onSend: (text: string, rawMode: boolean) => void;
  onStop?: () => void;
}

export function Composer({ disabled, streaming, onSend, onStop }: Props) {
  const [text, setText] = useState('');
  const [rawMode, setRawMode] = useState(false);

  const send = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled || streaming) return;
    onSend(trimmed, rawMode);
    setText('');
    setRawMode(false); // raw mode never persists across messages
  }, [text, rawMode, disabled, streaming, onSend]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="bg-sp-surface border-sp-line m-2 rounded-lg border p-2 focus-within:border-sp-accent/50 focus-within:ring-1 focus-within:ring-sp-accent/30">
      <textarea
        aria-label="Chat message"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        placeholder={
          disabled
            ? 'Chat is unavailable until an AI provider is set up.'
            : 'Ask about the active request or response…'
        }
        rows={3}
        className="w-full resize-none bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <label
          htmlFor="composer-raw-mode"
          className="flex items-center gap-2 text-sp-11 text-muted-foreground"
        >
          <Switch
            id="composer-raw-mode"
            checked={rawMode}
            onCheckedChange={(c) => setRawMode(c)}
            disabled={disabled || streaming}
          />
          Send raw (skip redaction)
        </label>
        <div className="flex items-center gap-2">
          <span
            data-testid="composer-shortcut-hint"
            className="text-sp-11 text-muted-foreground"
            aria-hidden="true"
          >
            {modLabel('Enter')} to send
          </span>
          {streaming ? (
            <Button size="sm" variant="outline" onClick={onStop}>
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={disabled || text.trim().length === 0}
              onClick={send}
              aria-keyshortcuts="Meta+Enter Control+Enter"
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
