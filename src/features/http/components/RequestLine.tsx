import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { HttpMethod } from '@/types';
import { Send, Code2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/shared/utils';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'] as const;

interface RequestLineProps {
  method: HttpMethod;
  url: string;
  isLoading: boolean;
  onMethodChange: (method: HttpMethod) => void;
  onUrlChange: (url: string) => void;
  onSend: () => void;
  onOpenCodeGen: () => void;
}

export default function RequestLine({
  method,
  url,
  isLoading,
  onMethodChange,
  onUrlChange,
  onSend,
  onOpenCodeGen,
}: RequestLineProps) {
  const [urlError, setUrlError] = useState<string | null>(null);

  const validateUrl = (newUrl: string) => {
    if (!newUrl) {
      setUrlError(null);
      return;
    }

    // Allow environment variables like {{baseUrl}}/path
    if (newUrl.includes('{{') && newUrl.includes('}}')) {
      setUrlError(null);
      return;
    }

    try {
      const urlToValidate = newUrl.startsWith('http') ? newUrl : `https://${newUrl}`;
      new URL(urlToValidate);
      setUrlError(null);
    } catch {
      setUrlError('Invalid URL format');
    }
  };

  const handleUrlChange = (newUrl: string) => {
    onUrlChange(newUrl);
    validateUrl(newUrl);
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 px-3 h-12 border-y glass-border-subtle glass-3 shrink-0">
        <Select value={method} onValueChange={(value) => onMethodChange(value as HttpMethod)}>
          <SelectTrigger
            className={cn(
              'w-20 h-7 font-mono font-bold text-[11px] border',
              method === 'GET' && 'bg-emerald-500/[0.12] border-emerald-500/25 text-emerald-400',
              method === 'POST' && 'bg-amber-500/[0.12] border-amber-500/25 text-amber-400',
              method === 'PUT' && 'bg-blue-500/[0.12] border-blue-500/25 text-blue-400',
              method === 'DELETE' && 'bg-rose-500/[0.12] border-rose-500/25 text-rose-400',
              method === 'PATCH' && 'bg-violet-500/[0.12] border-violet-500/25 text-violet-400',
              (method === 'OPTIONS' || method === 'HEAD') && 'bg-muted/[0.12] border-border text-muted-foreground'
            )}
            aria-label="HTTP Method"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-popover border-border">
            {HTTP_METHODS.map((m) => (
              <SelectItem key={m} value={m} className="font-mono font-semibold">
                <span
                  className={cn(
                    m === 'GET' && 'text-emerald-400',
                    m === 'POST' && 'text-amber-400',
                    m === 'PUT' && 'text-blue-400',
                    m === 'DELETE' && 'text-red-400',
                    m === 'PATCH' && 'text-violet-400',
                    (m === 'OPTIONS' || m === 'HEAD') && 'text-muted-foreground'
                  )}
                >
                  {m}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="text-muted-foreground/40 font-mono text-sm select-none shrink-0">›</span>

        <Input
          value={url}
          onChange={(e) => handleUrlChange(e.target.value)}
          placeholder={ECHO_URLS.http}
          className={cn(
            'flex-1 h-7 bg-transparent border-0 font-mono text-sm px-2',
            'focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none',
            'placeholder:text-muted-foreground/40',
            urlError && 'text-red-400'
          )}
          aria-invalid={!!urlError}
          aria-describedby={urlError ? 'url-error' : undefined}
          aria-label="Request URL"
        />

        <Button
          variant="glow"
          size="sm"
          onClick={onSend}
          disabled={isLoading || !url || !!urlError}
          className="h-7 min-w-[72px] text-xs font-medium bg-primary/[0.2] border-primary/40 hover:bg-primary/[0.35] hover:shadow-[0_0_20px_hsl(var(--primary)/0.4)] transition-colors duration-200"
          aria-label={isLoading ? 'Sending request' : 'Send request'}
        >
          {isLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <>
              <Send className="h-3 w-3 mr-1.5" />
              Send
            </>
          )}
        </Button>

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onOpenCodeGen}
          disabled={!url}
          className="h-7 w-7 text-muted-foreground"
          aria-label="Generate code snippet"
        >
          <Code2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {urlError && (
        <p id="url-error" className="text-xs text-red-400 px-3 py-0.5" role="alert">
          {urlError}
        </p>
      )}
    </div>
  );
}
