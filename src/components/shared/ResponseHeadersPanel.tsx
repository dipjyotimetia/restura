import { Check, Copy } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { filterHeaders, headersToText } from '@/lib/shared/responseFiles';

type HeaderEntry = [string, string | string[]];

/** Response headers: filter by name or value, copy one, or copy all. */
export function ResponseHeadersPanel({ entries }: { entries: HeaderEntry[] }) {
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const visible = useMemo(() => filterHeaders(entries, filter), [entries, filter]);

  const copy = async (id: string, text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      toast.success(`${label} copied`);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.error(`Failed to copy ${label.toLowerCase()}`);
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 flex items-center gap-2 px-4 pt-3 pb-2 bg-sp-surface border-b border-sp-line">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter ${entries.length} headers by name or value…`}
          aria-label="Filter response headers"
          className="flex-1 h-7 px-2 rounded-sp-btn bg-sp-surface-lo border border-sp-line text-sp-12 font-mono outline-none focus:border-sp-line-strong"
        />
        <button
          type="button"
          onClick={() => void copy('*', headersToText(visible), 'Headers')}
          disabled={visible.length === 0}
          className="inline-flex h-7 items-center gap-1.5 rounded-sp-btn px-2 text-sp-12 text-sp-muted hover:text-sp-text hover:bg-sp-hover disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
        >
          {copied === '*' ? (
            <Check className="h-3 w-3 text-emerald-400" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
          {filter.trim() ? `Copy ${visible.length}` : 'Copy all'}
        </button>
      </div>
      {visible.length === 0 && (
        <p className="px-4 py-6 text-center text-sp-12 text-sp-dim">No headers match “{filter}”.</p>
      )}
      <div className="px-3 py-1">
        {visible.map(([key, value]) => (
          <div
            key={key}
            className="group grid grid-cols-[200px_1fr_auto] gap-3 py-1.5 border-b border-sp-line items-start"
          >
            <span className="font-mono text-sp-12 text-sp-muted truncate">{key}</span>
            <span className="font-mono text-sp-12 text-sp-text break-all">
              {Array.isArray(value) ? value.join(', ') : value}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => void copy(key, headersToText([[key, value]]), 'Header')}
                  aria-label={copied === key ? 'Copied!' : 'Copy header'}
                  className="size-5 inline-flex items-center justify-center text-sp-dim hover:text-sp-text opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity rounded-sp-chip hover:bg-sp-hover"
                >
                  {copied === key ? (
                    <Check className="h-3 w-3 text-emerald-400" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>{copied === key ? 'Copied!' : 'Copy header'}</TooltipContent>
            </Tooltip>
          </div>
        ))}
      </div>
    </div>
  );
}
