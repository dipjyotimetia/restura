import { Send, Code2, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { badgeVariants } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';
import { cn } from '@/lib/shared/utils';
import type { HttpMethod } from '@/types';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'] as const;

type MethodBadge = 'get' | 'post' | 'put' | 'delete' | 'patch' | 'options' | 'head';
const METHOD_BADGE: Record<HttpMethod, MethodBadge> = {
  GET: 'get',
  POST: 'post',
  PUT: 'put',
  DELETE: 'delete',
  PATCH: 'patch',
  OPTIONS: 'options',
  HEAD: 'head',
};
const METHOD_TEXT_COLOR: Record<HttpMethod, string> = {
  GET: 'text-emerald-400',
  POST: 'text-amber-400',
  PUT: 'text-blue-400',
  DELETE: 'text-rose-400',
  PATCH: 'text-violet-400',
  OPTIONS: 'text-muted-foreground',
  HEAD: 'text-muted-foreground',
};

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
      <div className="flex items-center gap-1 px-3 h-12 border-y border-sp-line bg-sp-surface shrink-0">
        <Select value={method} onValueChange={(value) => onMethodChange(value as HttpMethod)}>
          <SelectTrigger
            className={cn(
              'w-20 h-7 font-mono text-[11px] tracking-wider justify-between',
              badgeVariants({ variant: METHOD_BADGE[method] }),
              'rounded-md px-2'
            )}
            aria-label="HTTP Method"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HTTP_METHODS.map((m) => (
              <SelectItem key={m} value={m} className="font-mono font-semibold">
                <span className={METHOD_TEXT_COLOR[m]}>{m}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="text-sp-dim font-mono text-sm select-none shrink-0">›</span>

        <Input
          value={url}
          onChange={(e) => handleUrlChange(e.target.value)}
          placeholder={ECHO_URLS.http}
          className={cn(
            'flex-1 h-7 bg-transparent border-0 font-mono text-sm px-2',
            'focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none',
            'placeholder:text-sp-dim',
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
          className="h-7 min-w-22 text-xs font-semibold"
          aria-label={isLoading ? 'Sending request' : 'Send request'}
        >
          {isLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <>
              <Send className="h-3 w-3 mr-1.5" />
              <span>Send</span>
              <Kbd className="ml-1.5 h-4 text-[9px] bg-primary/15 text-primary/90 border-primary/30">
                ⌘↵
              </Kbd>
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
