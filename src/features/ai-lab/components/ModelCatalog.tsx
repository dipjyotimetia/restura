import { Box, Search, Star } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ModelOption } from '../lib/modelOptions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/shared/utils';

export function ModelCatalog({
  options,
  favoriteKeys,
  onToggleFavorite,
}: {
  options: ModelOption[];
  favoriteKeys: ReadonlySet<string>;
  onToggleFavorite: (key: string) => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => {
      const detail = option.detail;
      return [
        option.shortLabel,
        option.model,
        option.cfg.label,
        option.cfg.provider,
        detail?.vendor,
        detail?.family,
        detail?.modality,
        detail?.parameterSize,
        detail?.quantizationLevel,
      ].some((value) => value?.toLowerCase().includes(needle));
    });
  }, [options, query]);

  if (options.length === 0) {
    return (
      <div className="flex min-h-72 flex-col items-center justify-center gap-2 border border-dashed border-sp-line p-8 text-center">
        <Box className="h-8 w-8 text-sp-dim" />
        <h3 className="text-sp-13 font-medium text-sp-text">No models discovered</h3>
        <p className="max-w-sm text-sp-12 text-sp-muted">
          Connect a provider to discover its models. The catalog will stay available across every AI
          Lab tool.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-sp-line px-3 py-2.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sp-muted" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search model catalog"
            placeholder={`Search ${options.length} models by name, ID, provider, or capability…`}
            className="pl-8"
          />
        </div>
        <span className="shrink-0 text-sp-11 text-sp-muted tabular-nums">
          {filtered.length} of {options.length}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="flex min-h-48 items-center justify-center p-6 text-sp-12 text-sp-muted">
            No models match “{query.trim()}”.
          </div>
        ) : (
          <div className="divide-y divide-sp-line">
            {filtered.map((option) => {
              const favorite = favoriteKeys.has(option.key);
              return (
                <article
                  key={option.key}
                  className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 hover:bg-sp-hover"
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <h3 className="truncate text-sp-12 font-medium text-sp-text">
                        {option.shortLabel}
                      </h3>
                      {option.isFavorite && <Badge variant="mono">favorite</Badge>}
                      {!option.isFavorite && option.recentRank !== null && (
                        <Badge variant="mono">recent</Badge>
                      )}
                    </div>
                    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sp-10 text-sp-muted">
                      <span className="font-medium text-sp-text-dim">{option.cfg.label}</span>
                      <span className="truncate font-mono" title={option.model}>
                        {option.model}
                      </span>
                      {metadata(option).map((item) => (
                        <span key={item} className="whitespace-nowrap">
                          {item}
                        </span>
                      ))}
                    </div>
                    {option.detail?.description && (
                      <p
                        className="mt-1 line-clamp-1 text-sp-11 text-sp-muted"
                        title={option.detail.description}
                      >
                        {option.detail.description}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${favorite ? 'Remove' : 'Add'} ${option.shortLabel} ${favorite ? 'from' : 'to'} favorites`}
                    title={favorite ? 'Remove from favorites' : 'Add to favorites'}
                    onClick={() => onToggleFavorite(option.key)}
                  >
                    <Star
                      className={cn(
                        'h-3.5 w-3.5',
                        favorite ? 'fill-amber-400 text-amber-400' : 'text-sp-muted'
                      )}
                    />
                  </Button>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function metadata(option: ModelOption): string[] {
  const detail = option.detail;
  if (!detail) return [];
  const values: string[] = [];
  if (detail.parameterSize) values.push(detail.parameterSize);
  if (detail.quantizationLevel) values.push(detail.quantizationLevel);
  if (detail.contextLength) values.push(formatTokens(detail.contextLength));
  if (detail.modality) values.push(detail.modality);
  if (detail.vendor) values.push(detail.vendor);
  if (detail.pricing?.promptPerMTokUSD !== undefined) {
    values.push(`$${detail.pricing.promptPerMTokUSD.toFixed(2)}/M input`);
  }
  return values;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K ctx`;
  return `${tokens} ctx`;
}
