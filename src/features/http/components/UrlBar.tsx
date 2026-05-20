'use client';

import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Send, Code2, Loader2, Link2 } from 'lucide-react';
import { cn } from '@/lib/shared/utils';
import {
  Floater,
  Kbd,
  MethodChip,
  VariableText,
  methodLabel,
} from '@/components/ui/spatial';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';
import type { HttpMethod } from '@/types';

const HTTP_METHODS: ReadonlyArray<HttpMethod> = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
];

const METHOD_TEXT: Record<HttpMethod, string> = {
  GET: '#22c55e',
  POST: '#f59e0b',
  PUT: '#3b82f6',
  PATCH: '#a855f7',
  DELETE: '#ef4444',
  HEAD: '#06b6d4',
  OPTIONS: '#94a3b8',
};

interface UrlBarProps {
  method: HttpMethod;
  url: string;
  isLoading: boolean;
  onMethodChange: (method: HttpMethod) => void;
  onUrlChange: (url: string) => void;
  onSend: () => void;
  onOpenCodeGen: () => void;
}

/**
 * Spatial Depth URL bar. Method chip + monospace URL field (with {{var}}
 * highlight overlay) inside a pill-radius Floater, with a glowing accent
 * Send button on the right.
 */
export function UrlBar({
  method,
  url,
  isLoading,
  onMethodChange,
  onUrlChange,
  onSend,
  onOpenCodeGen,
}: UrlBarProps) {
  const [urlError, setUrlError] = useState<string | null>(null);

  const validateUrl = (newUrl: string) => {
    if (!newUrl) {
      setUrlError(null);
      return;
    }
    if (newUrl.includes('{{') && newUrl.includes('}}')) {
      setUrlError(null);
      return;
    }
    try {
      const candidate = newUrl.startsWith('http') ? newUrl : `https://${newUrl}`;
      new URL(candidate);
      setUrlError(null);
    } catch {
      setUrlError('Invalid URL format');
    }
  };

  const handleUrlChange = (next: string) => {
    onUrlChange(next);
    validateUrl(next);
  };

  return (
    <div className="px-3 pt-3 pb-2 shrink-0">
      <div className="flex items-stretch gap-2.5">
        {/* Url pill */}
        <Floater
          radius="pill"
          elevation="float"
          className="flex-1 flex items-center gap-2 px-2 h-10 bg-sp-surface min-w-0"
        >
          {/* Method chip + picker — Radix DropdownMenu portals the panel
              so it escapes the parent Floater's backdrop-filter stacking
              context (which otherwise traps a locally-positioned dropdown
              underneath the sibling SubTabBar). */}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                aria-label={`HTTP method: ${method}`}
                className="focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sp-accent-glow-33)] rounded-sp-btn shrink-0"
              >
                <MethodChip method={methodLabel(method)} hasPicker />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="start"
                sideOffset={8}
                className={cn(
                  'z-50 w-32 rounded-sp-panel sp-floater-lg overflow-hidden p-0.5',
                  'data-[state=open]:animate-sp-fade-in'
                )}
              >
                {HTTP_METHODS.map((m) => (
                  <DropdownMenu.Item
                    key={m}
                    onSelect={() => onMethodChange(m)}
                    className={cn(
                      'w-full px-2.5 py-1.5 rounded-sp-btn outline-none cursor-default',
                      'font-mono font-semibold text-sp-12 tabular-nums',
                      'data-[highlighted]:bg-sp-hover transition-colors',
                      m === method && 'bg-sp-active'
                    )}
                    style={{ color: METHOD_TEXT[m] }}
                  >
                    {m === 'DELETE' ? 'DEL' : m}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>

          {/* URL field with variable highlight overlay */}
          <div className="relative flex-1 min-w-0 h-7 flex items-center">
            <input
              type="text"
              value={url}
              onChange={(e) => handleUrlChange(e.target.value)}
              placeholder={ECHO_URLS.http}
              spellCheck={false}
              aria-label="Request URL"
              aria-invalid={!!urlError}
              aria-describedby={urlError ? 'url-error' : undefined}
              className={cn(
                'w-full bg-transparent outline-none font-mono text-sp-13 tabular-nums caret-sp-accent',
                'placeholder:text-sp-dim',
                urlError ? 'text-rose-400' : 'text-sp-text',
                // Make the visible glyphs transparent only when we have a
                // {{var}} to overlay-render; otherwise show the raw input.
                url.includes('{{') && url.includes('}}') && !urlError && 'text-transparent caret-sp-accent'
              )}
            />
            {url.includes('{{') && url.includes('}}') && !urlError && (
              <div
                aria-hidden="true"
                className="absolute inset-0 pointer-events-none flex items-center overflow-hidden"
              >
                <VariableText
                  text={url}
                  className="font-mono text-sp-13 text-sp-text tabular-nums whitespace-pre"
                />
              </div>
            )}
          </div>

          {/* Inline icon affordances */}
          <div className="flex items-center gap-0.5 shrink-0 pr-1">
            <button
              type="button"
              onClick={onOpenCodeGen}
              disabled={!url}
              aria-label="Generate code snippet"
              className={cn(
                'inline-flex items-center justify-center h-7 w-7 rounded-sp-btn text-sp-dim',
                'hover:text-sp-text hover:bg-sp-hover transition-colors',
                'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent'
              )}
            >
              <Code2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (!url) return;
                void navigator.clipboard?.writeText(url);
              }}
              disabled={!url}
              aria-label="Copy URL"
              className={cn(
                'inline-flex items-center justify-center h-7 w-7 rounded-sp-btn text-sp-dim',
                'hover:text-sp-text hover:bg-sp-hover transition-colors',
                'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent'
              )}
            >
              <Link2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </Floater>

        {/* Send button */}
        <button
          type="button"
          onClick={onSend}
          disabled={isLoading || !url || !!urlError}
          aria-label={isLoading ? 'Sending request' : 'Send request'}
          className={cn(
            'inline-flex items-center justify-center gap-1.5 px-4 h-10 rounded-sp-pill shrink-0',
            'font-semibold text-sp-13 text-white tracking-wide select-none',
            'transition-[transform,filter] active:translate-y-px hover:brightness-110',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sp-accent-glow-55)]',
            'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100'
          )}
          style={{
            background:
              'linear-gradient(180deg, var(--sp-accent), color-mix(in srgb, var(--sp-accent), black 20%))',
            boxShadow:
              '0 8px 24px var(--sp-accent-glow-55), inset 0 1px 0 rgba(255,255,255,0.3), 0 0 0 1px var(--sp-accent)',
          }}
        >
          {isLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <>
              <Send className="h-3.5 w-3.5" />
              <span>Send</span>
              <Kbd
                size="xs"
                className="ml-0.5 border-white/30 bg-white/15 text-white"
              >
                ⌘↵
              </Kbd>
            </>
          )}
        </button>
      </div>
      {urlError && (
        <p
          id="url-error"
          role="alert"
          className="mt-1 px-3 text-sp-11 text-rose-400 font-medium"
        >
          {urlError}
        </p>
      )}
    </div>
  );
}

export default UrlBar;
