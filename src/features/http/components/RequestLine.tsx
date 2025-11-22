'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { HttpMethod } from '@/types';
import { Send, Code2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/shared/utils';

// Method color mapping with icons for better accessibility
const methodColors: Record<string, string> = {
  GET: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30 hover:bg-green-500/20',
  POST: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/20',
  PUT: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30 hover:bg-blue-500/20',
  DELETE: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30 hover:bg-red-500/20',
  PATCH: 'bg-slate-blue-500/10 text-slate-blue-600 dark:text-slate-blue-400 border-slate-blue-500/30 hover:bg-slate-blue-500/20',
  OPTIONS: 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30 hover:bg-gray-500/20',
  HEAD: 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30 hover:bg-gray-500/20',
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
              'w-32 font-mono font-semibold border-2 transition-colors bg-background border-border',
              methodColors[method]
            )}
            aria-label="HTTP Method"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-popover border-border">
            {Object.keys(methodColors).map((m) => (
              <SelectItem key={m} value={m} className="font-mono font-semibold">
                <span className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded bg-current/10 flex items-center justify-center text-xs font-bold">
                    {methodIcons[m]}
                  </span>
                  <span
                    className={cn(
                      m === 'GET' && 'text-green-600 dark:text-green-400',
                      m === 'POST' && 'text-yellow-600 dark:text-yellow-400',
                      m === 'PUT' && 'text-blue-600 dark:text-blue-400',
                      m === 'DELETE' && 'text-red-600 dark:text-red-400',
                      m === 'PATCH' && 'text-slate-blue-600 dark:text-slate-blue-400',
                      (m === 'OPTIONS' || m === 'HEAD') && 'text-gray-600 dark:text-gray-400'
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
              'w-full font-mono text-sm bg-background focus:border-slate-blue-500/40 border-border',
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
          className="border-border hover:border-border"
          aria-label="Generate code snippet"
        >
          <Code2 className="mr-2 h-4 w-4" />
          Code
        </Button>

        <Button
          onClick={onSend}
          disabled={isLoading || !url || !!urlError}
          className="min-w-[120px]"
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
