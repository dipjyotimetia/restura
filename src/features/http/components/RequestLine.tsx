'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { HttpMethod } from '@/types';
import { Send, Code2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/shared/utils';

// Enhanced method color mapping with glow effects
const methodStyles: Record<string, { base: string; glow: string }> = {
  GET: {
    base: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/25',
    glow: 'shadow-[0_0_12px_-3px] shadow-emerald-500/30',
  },
  POST: {
    base: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/25',
    glow: 'shadow-[0_0_12px_-3px] shadow-amber-500/30',
  },
  PUT: {
    base: 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30 hover:bg-blue-500/25',
    glow: 'shadow-[0_0_12px_-3px] shadow-blue-500/30',
  },
  DELETE: {
    base: 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30 hover:bg-red-500/25',
    glow: 'shadow-[0_0_12px_-3px] shadow-red-500/30',
  },
  PATCH: {
    base: 'bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/30 hover:bg-violet-500/25',
    glow: 'shadow-[0_0_12px_-3px] shadow-violet-500/30',
  },
  OPTIONS: {
    base: 'bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/30 hover:bg-slate-500/25',
    glow: 'shadow-[0_0_12px_-3px] shadow-slate-500/30',
  },
  HEAD: {
    base: 'bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/30 hover:bg-slate-500/25',
    glow: 'shadow-[0_0_12px_-3px] shadow-slate-500/30',
  },
};


// Method icons for non-color indicators (accessibility)
const methodIcons: Record<string, string> = {
  GET: 'G',
  POST: 'P',
  PUT: 'U',
  DELETE: 'D',
  PATCH: 'A',
  OPTIONS: 'O',
  HEAD: 'H',
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
    <div className="p-4 border-b border-border bg-transparent">
      <div className="flex gap-2">
        <Select value={method} onValueChange={(value) => onMethodChange(value as HttpMethod)}>
          <SelectTrigger
            className={cn(
              'w-28 font-mono font-bold tracking-tight border transition-all duration-200 bg-background',
              methodStyles[method]?.base,
              methodStyles[method]?.glow
            )}
            aria-label="HTTP Method"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-popover border-border">
            {Object.keys(methodStyles).map((m) => (
              <SelectItem key={m} value={m} className="font-mono font-semibold">
                <span className="flex items-center gap-2">
                  <span className={cn(
                    "w-5 h-5 rounded flex items-center justify-center text-xs font-bold",
                    m === 'GET' && 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400',
                    m === 'POST' && 'bg-amber-500/20 text-amber-600 dark:text-amber-400',
                    m === 'PUT' && 'bg-blue-500/20 text-blue-600 dark:text-blue-400',
                    m === 'DELETE' && 'bg-red-500/20 text-red-600 dark:text-red-400',
                    m === 'PATCH' && 'bg-violet-500/20 text-violet-600 dark:text-violet-400',
                    (m === 'OPTIONS' || m === 'HEAD') && 'bg-slate-500/20 text-slate-600 dark:text-slate-400'
                  )}>
                    {methodIcons[m]}
                  </span>
                  <span
                    className={cn(
                      m === 'GET' && 'text-emerald-600 dark:text-emerald-400',
                      m === 'POST' && 'text-amber-600 dark:text-amber-400',
                      m === 'PUT' && 'text-blue-600 dark:text-blue-400',
                      m === 'DELETE' && 'text-red-600 dark:text-red-400',
                      m === 'PATCH' && 'text-violet-600 dark:text-violet-400',
                      (m === 'OPTIONS' || m === 'HEAD') && 'text-slate-600 dark:text-slate-400'
                    )}
                  >
                    {m}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex-1 relative">
          <Input
            value={url}
            onChange={(e) => handleUrlChange(e.target.value)}
            placeholder="Enter request URL (e.g., https://api.example.com/users)"
            className={cn(
              'w-full font-mono text-sm bg-background focus:border-slate-blue-500/40 border-border placeholder:text-muted-foreground/70',
              urlError
                ? 'border-red-500/50 focus:border-red-500/70 bg-red-50/50 dark:bg-red-950/20'
                : 'border-border'
            )}
            aria-invalid={!!urlError}
            aria-describedby={urlError ? 'url-error' : undefined}
            aria-label="Request URL"
          />
          {urlError && (
            <p id="url-error" className="absolute -bottom-5 left-0 text-xs text-red-600 dark:text-red-400" role="alert">
              {urlError}
            </p>
          )}
        </div>

        <Button
          variant="outline"
          onClick={onOpenCodeGen}
          disabled={!url}
          className="border-border hover:border-border disabled:bg-muted disabled:border-border"
          aria-label="Generate code snippet"
        >
          <Code2 className="mr-2 h-4 w-4" />
          Code
        </Button>

        <Button
          onClick={onSend}
          disabled={isLoading || !url || !!urlError}
          className="min-w-[120px] bg-primary disabled:bg-muted disabled:text-muted-foreground disabled:border-border"
          aria-label={isLoading ? 'Sending request' : 'Send request'}
        >
          {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
          {isLoading ? 'Sending...' : 'Send'}
          {!isLoading && (
            <kbd className="ml-2 pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-white/20 px-1.5 font-mono text-[10px] font-medium opacity-70">
              <span className="text-xs">⌘</span>↵
            </kbd>
          )}
        </Button>
      </div>
    </div>
  );
}
