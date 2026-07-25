import { History, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Stagger, StaggerItem } from '@/components/ui/motion';
import { TabsContent } from '@/components/ui/tabs';
import { httpLikeStatus } from '@/lib/shared/console-format';
import { METHOD_COLORS, PROTOCOL_LABELS } from '@/lib/shared/constants';
import { cn } from '@/lib/shared/utils';
import type { HistoryItem } from '@/types';
import { SidebarEmptyState } from './SidebarEmptyState';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;

interface SidebarHistoryPanelProps {
  filteredHistory: HistoryItem[];
  favorites: string[];
  hasMoreHistory: boolean;
  methodFilter: string | null;
  searchQuery: string;
  staggerInitial: false | 'hidden';
  totalHistoryCount: number;
  visibleHistoryCount: number;
  onLoadHistoryItem: (itemId: string) => void;
  onLoadMore: () => void;
  onMethodFilterChange: (method: string | null) => void;
  onToggleFavorite: (itemId: string) => void;
}

export function SidebarHistoryPanel({
  filteredHistory,
  favorites,
  hasMoreHistory,
  methodFilter,
  searchQuery,
  staggerInitial,
  totalHistoryCount,
  visibleHistoryCount,
  onLoadHistoryItem,
  onLoadMore,
  onMethodFilterChange,
  onToggleFavorite,
}: SidebarHistoryPanelProps) {
  return (
    <TabsContent value="history" className="flex-1 overflow-auto p-3 mt-0">
      {totalHistoryCount > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          <Button
            variant={methodFilter === null ? 'secondary' : 'ghost'}
            size="sm"
            className="h-6 text-[10px] px-2"
            onClick={() => onMethodFilterChange(null)}
          >
            All
          </Button>
          {HTTP_METHODS.map((method) => (
            <Button
              key={method}
              variant={methodFilter === method ? 'secondary' : 'ghost'}
              size="sm"
              className={cn(
                'h-6 text-[10px] font-mono px-2',
                methodFilter === method && METHOD_COLORS[method]
              )}
              onClick={() => onMethodFilterChange(methodFilter === method ? null : method)}
            >
              {method}
            </Button>
          ))}
        </div>
      )}

      {filteredHistory.length === 0 ? (
        <SidebarEmptyState
          icon={History}
          title={searchQuery || methodFilter ? 'No matching requests' : 'No history yet'}
          hint={
            searchQuery || methodFilter
              ? 'Try adjusting your filters'
              : 'Send a request to see it here'
          }
        />
      ) : (
        <Stagger className="flex flex-col gap-0.5" initial={staggerInitial}>
          {filteredHistory.map((item) => (
            <StaggerItem
              key={item.id}
              className="group px-1.5 py-1.5 rounded hover:bg-accent cursor-pointer transition-colors"
              onClick={() => onLoadHistoryItem(item.id)}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleFavorite(item.id);
                  }}
                  aria-label={
                    favorites.includes(item.id) ? 'Remove from favorites' : 'Add to favorites'
                  }
                >
                  <Star
                    className={cn(
                      'h-3.5 w-3.5 transition-all',
                      favorites.includes(item.id)
                        ? 'text-amber-500 fill-amber-500 scale-110'
                        : 'text-sp-dim group-hover:text-amber-500'
                    )}
                  />
                </Button>
                <Badge
                  variant={
                    item.request.type === 'http'
                      ? (item.request.method.toLowerCase() as
                          | 'get'
                          | 'post'
                          | 'put'
                          | 'delete'
                          | 'patch'
                          | 'options'
                          | 'head')
                      : 'mono'
                  }
                  className="text-[9px] h-4 px-1"
                >
                  {item.request.type === 'http'
                    ? item.request.method
                    : PROTOCOL_LABELS[item.request.type]}
                </Badge>
                {item.response &&
                  (() => {
                    const status = httpLikeStatus(item.request.type, item.response.status);
                    return (
                      <span
                        className={cn(
                          'text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded tabular-nums',
                          status >= 200 && status < 300
                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            : status >= 400
                              ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                              : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                        )}
                      >
                        {status}
                      </span>
                    );
                  })()}
              </div>
              <p className="text-xs font-mono truncate pl-6 mb-1 text-foreground">
                {item.request.type === 'grpc'
                  ? item.request.service
                  : (item.resolvedUrl ?? item.request.url)}
              </p>
              <span className="text-[10px] text-sp-dim pl-6 block">
                {new Date(item.timestamp).toLocaleString()}
              </span>
            </StaggerItem>
          ))}
        </Stagger>
      )}
      {hasMoreHistory && !searchQuery && !methodFilter && (
        <Button variant="outline" size="sm" className="w-full mt-3 text-xs" onClick={onLoadMore}>
          Load More ({totalHistoryCount - visibleHistoryCount} remaining)
        </Button>
      )}
    </TabsContent>
  );
}
