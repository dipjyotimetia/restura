import { useState, useCallback, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

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
    <div className="glass-1 border-sp-line m-2 rounded-lg border p-2 focus-within:border-sp-accent/50 focus-within:ring-1 focus-within:ring-sp-accent/30">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        placeholder={
          disabled
            ? 'Add an API key in Settings → AI to start chatting.'
            : 'Ask about the active request or response… (⌘+Enter to send)'
        }
        rows={3}
        className="w-full resize-none bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Switch
            checked={rawMode}
            onCheckedChange={(c) => setRawMode(c)}
            disabled={disabled || streaming}
          />
          Send raw (skip redaction)
        </label>
        {streaming ? (
          <Button size="sm" variant="outline" onClick={onStop}>
            Stop
          </Button>
        ) : (
          <Button size="sm" disabled={disabled || text.trim().length === 0} onClick={send}>
            Send
          </Button>
        )}
      </div>
    </div>
  );
}
