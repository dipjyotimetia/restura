import { HelpCircle, ListChecks, Search, SlidersHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/shared/utils';
import type { ConsoleEntry, ConsoleProtocol, ConsoleStatusFilter } from '@/store/useConsoleStore';
import RequestEntryItem from './RequestEntryItem';
import {
  type NetworkSort,
  PROTOCOL_FILTERS,
  SORT_OPTIONS,
  STATUS_FILTERS,
} from './useNetworkFilters';

interface NetworkEntryListProps {
  classCounts: Partial<Record<ConsoleStatusFilter, number>>;
  compareIds: string[];
  filtersActive: boolean;
  filteredEntries: ConsoleEntry[];
  maxTime: number;
  protocolFilter: ConsoleProtocol | 'all';
  protocolsPresent: Set<string>;
  removeEntry: (id: string) => void;
  runFilter: string;
  runs: Array<{ id: string; label: string }>;
  searchFilter: string;
  selectedEntryId: string | null;
  setProtocolFilter: (value: ConsoleProtocol | 'all') => void;
  setRunFilter: (value: string) => void;
  setSearchFilter: (value: string) => void;
  setSortBy: (value: NetworkSort) => void;
  setStatusFilter: (value: ConsoleStatusFilter) => void;
  sortBy: NetworkSort;
  statusFilter: ConsoleStatusFilter;
  toggleCompare: (id: string) => void;
  togglePin: (id: string) => void;
  selectEntry: (id: string) => void;
}

/** Renderer-only list boundary. It deliberately remains a plain mapped list. */
export default function NetworkEntryList({
  classCounts,
  compareIds,
  filtersActive,
  filteredEntries,
  maxTime,
  protocolFilter,
  protocolsPresent,
  removeEntry,
  runFilter,
  runs,
  searchFilter,
  selectedEntryId,
  setProtocolFilter,
  setRunFilter,
  setSearchFilter,
  setSortBy,
  setStatusFilter,
  sortBy,
  statusFilter,
  toggleCompare,
  togglePin,
  selectEntry,
}: NetworkEntryListProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const moveSelection = useCallback(
    (direction: 1 | -1) => {
      if (filteredEntries.length === 0) return;
      const index = filteredEntries.findIndex((entry) => entry.id === selectedEntryId);
      const next =
        index < 0
          ? direction === 1
            ? 0
            : filteredEntries.length - 1
          : Math.min(filteredEntries.length - 1, Math.max(0, index + direction));
      const entry = filteredEntries[next];
      if (entry) selectEntry(entry.id);
    },
    [filteredEntries, selectedEntryId, selectEntry]
  );

  const handleListKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'ArrowDown' || event.key === 'j') {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === 'ArrowUp' || event.key === 'k') {
        event.preventDefault();
        moveSelection(-1);
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!selectedEntryId) return;
        event.preventDefault();
        const index = filteredEntries.findIndex((entry) => entry.id === selectedEntryId);
        const replacement = filteredEntries[index + 1] ?? filteredEntries[index - 1];
        removeEntry(selectedEntryId);
        if (replacement) selectEntry(replacement.id);
      } else if (
        event.key.toLowerCase() === 'p' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        if (!selectedEntryId) return;
        event.preventDefault();
        togglePin(selectedEntryId);
      }
    },
    [filteredEntries, moveSelection, removeEntry, selectedEntryId, selectEntry, togglePin]
  );

  useEffect(() => {
    if (!selectedEntryId || !listRef.current) return;
    listRef.current
      .querySelector<HTMLElement>(`[data-entry-id="${selectedEntryId}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedEntryId]);

  return (
    <div className="w-[280px] border-r border-border flex-shrink-0 flex flex-col">
      <div className="p-2 border-b border-border space-y-2">
        <div className="flex items-center gap-1">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <Input
              placeholder="Filter… try status:5xx -url:health"
              value={searchFilter}
              onChange={(event) => setSearchFilter(event.target.value)}
              className="h-7 pl-7 pr-12 text-xs"
              title={
                'Filter DSL\n' +
                '  plain text         → match anywhere\n' +
                '  "quoted phrase"    → preserves spaces\n' +
                '  status:5xx | 200   → status class or number\n' +
                '  method:POST        → HTTP method\n' +
                '  url:/users         url:~regex\n' +
                '  host:api.foo.com   protocol:graphql\n' +
                '  has:body | cookie | test | script\n' +
                '  -<token>           → negate\n' +
                'Multiple tokens AND together.'
              }
            />
            {searchFilter ? (
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-0.5 top-1/2 -translate-y-1/2 h-6 w-6"
                onClick={() => setSearchFilter('')}
              >
                <X className="h-3 w-3" />
              </Button>
            ) : (
              <HelpCircle
                className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-sp-dim pointer-events-none"
                aria-hidden="true"
              />
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                aria-label="Sort and protocol filters"
                title="Sort & filter"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel className="text-[11px]">Sort by</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={sortBy}
                onValueChange={(value) => setSortBy(value as NetworkSort)}
              >
                {SORT_OPTIONS.map((option) => (
                  <DropdownMenuRadioItem
                    key={option.value}
                    value={option.value}
                    className="text-xs"
                  >
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {protocolsPresent.size > 1 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-[11px]">Protocol</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={protocolFilter}
                    onValueChange={(value) => setProtocolFilter(value as ConsoleProtocol | 'all')}
                  >
                    {PROTOCOL_FILTERS.map((option) => (
                      <DropdownMenuRadioItem
                        key={option.value}
                        value={option.value}
                        className="text-xs"
                      >
                        {option.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex flex-wrap gap-1">
          {STATUS_FILTERS.map((filter) => {
            const count = classCounts[filter.value] ?? 0;
            return (
              <button
                key={filter.value}
                type="button"
                onClick={() => setStatusFilter(filter.value)}
                className={cn(
                  'inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors',
                  statusFilter === filter.value
                    ? 'bg-primary/15 border-primary/40 text-primary'
                    : 'bg-muted/30 border-transparent text-muted-foreground hover:bg-muted/60',
                  filter.value !== 'all' && count === 0 && 'opacity-50'
                )}
                aria-pressed={statusFilter === filter.value}
              >
                <span>{filter.label}</span>
                {count > 0 && (
                  <span
                    className={cn(
                      'text-[9px] tabular-nums px-1 rounded-sm',
                      statusFilter === filter.value ? 'bg-primary/20' : 'bg-muted-foreground/15'
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {runs.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <ListChecks className="h-3 w-3 text-muted-foreground" />
            <button
              type="button"
              onClick={() => setRunFilter('all')}
              className={cn(
                'text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors',
                runFilter === 'all'
                  ? 'bg-primary/15 border-primary/40 text-primary'
                  : 'bg-muted/30 border-transparent text-muted-foreground hover:bg-muted/60'
              )}
            >
              All
            </button>
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => setRunFilter(run.id)}
                title={run.label}
                className={cn(
                  'text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors max-w-[90px] truncate',
                  runFilter === run.id
                    ? 'bg-primary/15 border-primary/40 text-primary'
                    : 'bg-muted/30 border-transparent text-muted-foreground hover:bg-muted/60'
                )}
              >
                {run.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <ScrollArea className="flex-1">
        <div
          ref={listRef}
          tabIndex={0}
          role="listbox"
          aria-label="Request log"
          aria-activedescendant={selectedEntryId ? `entry-${selectedEntryId}` : undefined}
          onKeyDown={handleListKeyDown}
          className="outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {filteredEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground px-4 text-center">
              <Search className="h-6 w-6 mb-2 opacity-30" />
              <p className="text-xs">
                {filtersActive ? 'No matching requests' : 'No requests yet'}
              </p>
              {filtersActive && (
                <button
                  type="button"
                  className="text-[10px] underline mt-2 text-primary"
                  onClick={() => {
                    setSearchFilter('');
                    setStatusFilter('all');
                    setProtocolFilter('all');
                    setRunFilter('all');
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            filteredEntries.map((entry) => (
              <div
                key={entry.id}
                id={`entry-${entry.id}`}
                data-entry-id={entry.id}
                role="option"
                aria-selected={entry.id === selectedEntryId}
              >
                <RequestEntryItem
                  entry={entry}
                  isSelected={entry.id === selectedEntryId}
                  onClick={() => selectEntry(entry.id)}
                  isCompareChecked={compareIds.includes(entry.id)}
                  onToggleCompare={() => toggleCompare(entry.id)}
                  onPinForCompare={() => toggleCompare(entry.id)}
                  maxTime={maxTime}
                />
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
