import { useEffect, useCallback, useMemo, useRef } from 'react';
import type { ConsoleLog, ConsoleTest } from '@/store/useConsoleStore';
import { useConsoleStore } from '@/store/useConsoleStore';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Cable, Download, HardDrive, Network, Terminal, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/shared/utils';
import { isElectron } from '@/lib/shared/platform';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { buildExportFile, downloadExportFile } from '@/lib/shared/console-export';
import { filterEntries } from '@/lib/shared/console-filter';
import { type ConsoleTabId } from '@/store/useConsoleStore';
import NetworkTab from './NetworkTab';
import ScriptsTab from './ScriptsTab';
import FramesTab from './FramesTab';

const CLEAR_LABELS: Record<ConsoleTabId, string> = {
  network: 'network logs',
  frames: 'frames',
  disk: 'disk log',
  scripts: 'console',
};

// Disk tab is Electron-only — lazy so the web bundle never imports it.
const DiskTab = lazyComponent(
  () => import('./DiskTab'),
  <div className="h-full flex items-center justify-center text-muted-foreground text-xs">Loading…</div>
);

// Vertical space reserved for app chrome (top bar, tab strip, status bar) plus
// a minimum usable request/response workspace. The console may not grow past
// (viewport − this), so expanding it never crushes the editor + response into
// an unusable sliver — the failure mode where switching request tabs showed
// nothing because the editor had collapsed to a few pixels.
const WORKSPACE_RESERVE_PX = 500;
const CONSOLE_MIN_PX = 120;

function maxConsoleHeight(): number {
  return Math.max(CONSOLE_MIN_PX, window.innerHeight - WORKSPACE_RESERVE_PX);
}

interface NetworkConsoleProps {
  scriptLogs?: ConsoleLog[];
  tests?: ConsoleTest[];
  onClearScripts?: () => void;
}

export default function NetworkConsole({ scriptLogs = [], tests, onClearScripts }: NetworkConsoleProps) {
  const {
    entries,
    frames,
    isExpanded,
    panelHeight,
    activeTab,
    preserveOnSend,
    searchFilter,
    statusFilter,
    protocolFilter,
    runFilter,
    setExpanded,
    setPanelHeight,
    setActiveTab,
    setPreserveOnSend,
    clearEntries,
    clearFrames,
  } = useConsoleStore();

  const containerRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const handleMove = (moveEvent: MouseEvent) => {
      if (!containerRef.current) return;
      const containerBottom = containerRef.current.getBoundingClientRect().bottom;
      const newHeight = containerBottom - moveEvent.clientY;
      const clampedHeight = Math.min(maxConsoleHeight(), Math.max(CONSOLE_MIN_PX, newHeight));
      setPanelHeight(clampedHeight);
    };

    const handleEnd = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleEnd);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleEnd);
  }, [setPanelHeight]);

  // Keyboard shortcut for toggling console — uses getState() to avoid stale closure
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        setExpanded(!useConsoleStore.getState().isExpanded);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setExpanded]);

  // Keep the console within the space budget — clamps an over-large persisted
  // height down on mount, and re-clamps when the window shrinks. Reads the live
  // height via getState() so the effect doesn't re-run on every resize tick.
  useEffect(() => {
    if (!isExpanded) return;
    const clamp = () => {
      const max = maxConsoleHeight();
      if (useConsoleStore.getState().panelHeight > max) setPanelHeight(max);
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [isExpanded, setPanelHeight]);

  const handleClear = () => {
    if (activeTab === 'network') {
      clearEntries();
    } else if (activeTab === 'frames') {
      clearFrames();
    } else {
      onClearScripts?.();
    }
  };

  const clearDisabled =
    (activeTab === 'network' && entries.length === 0) ||
    (activeTab === 'frames' && frames.length === 0) ||
    (activeTab === 'scripts' && scriptLogs.length === 0 && (!tests || tests.length === 0));

  // Filtered set mirrors what NetworkTab currently shows. Computed here too so
  // the export menu — which lives in the panel header, not inside NetworkTab —
  // can offer "Export filtered" without prop-drilling through the tab stack.
  const filteredEntries = useMemo(
    () => filterEntries(entries, {
      query: searchFilter,
      statusFilter,
      protocolFilter,
      runFilter,
    }),
    [entries, searchFilter, statusFilter, protocolFilter, runFilter]
  );
  const filtersActive =
    searchFilter.trim() !== '' ||
    statusFilter !== 'all' ||
    protocolFilter !== 'all' ||
    runFilter !== 'all';

  const handleExport = (format: 'har' | 'ndjson' | 'curl', scope: 'all' | 'filtered' = 'all') => {
    const list = scope === 'filtered' ? filteredEntries : entries;
    if (list.length === 0) {
      toast.error('Nothing to export');
      return;
    }
    const file = buildExportFile(format, list);
    downloadExportFile(file);
    toast.success(`Exported ${list.length} ${scope === 'filtered' ? 'filtered ' : ''}entries to ${file.filename}`);
  };

  const passedTests = tests?.filter((t) => t.passed).length ?? 0;
  const failedTests = (tests?.length ?? 0) - passedTests;
  const showDiskTab = isElectron();

  const renderActiveTab = () => {
    if (activeTab === 'network') return <NetworkTab />;
    if (activeTab === 'frames') return <FramesTab />;
    if (activeTab === 'disk' && showDiskTab) return <DiskTab />;
    return <ScriptsTab logs={scriptLogs} {...(tests !== undefined && { tests })} />;
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div
        ref={containerRef}
        className="flex flex-col border-t glass-border-subtle glass-2 relative z-10"
        style={{ height: isExpanded ? panelHeight : 28 }}
      >
        {/* Resize handle — wider hit zone, visible grip. The padding is what
            makes the handle easy to grab; the visible thumb is purely cosmetic. */}
        {isExpanded && (
          <div
            className="absolute -top-2 left-0 right-0 h-4 cursor-row-resize z-20 flex items-center justify-center group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onMouseDown={handleResizeStart}
            onKeyDown={(e) => {
              const step = 20;
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setPanelHeight(Math.min(maxConsoleHeight(), panelHeight + step));
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setPanelHeight(Math.max(CONSOLE_MIN_PX, panelHeight - step));
              }
            }}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize console panel"
            aria-valuenow={Math.round(panelHeight)}
            aria-valuemin={120}
            tabIndex={0}
          >
            <div className="h-1 w-10 rounded-full bg-border group-hover:bg-primary/60 group-focus-visible:bg-primary/60 transition-colors" />
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between px-3 h-7 shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-mono uppercase tracking-widest text-muted-foreground/60 select-none">
              Console
            </span>
            {isExpanded && (
              <Tabs
                value={activeTab === 'disk' && !showDiskTab ? 'network' : activeTab}
                onValueChange={(v) => setActiveTab(v as ConsoleTabId)}
              >
                <TabsList className="h-7 px-0 border-none bg-transparent gap-0">
                  <TabsTrigger value="network" className="text-[11px] h-7 px-2 font-medium">
                    <Network className="h-3 w-3 mr-1.5" />
                    Network
                    {entries.length > 0 && (
                      <Badge variant="secondary" className="ml-1.5 text-[9px] h-4 px-1">
                        {entries.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="frames" className="text-[11px] h-7 px-2 font-medium">
                    <Cable className="h-3 w-3 mr-1.5" />
                    Frames
                    {frames.length > 0 && (
                      <Badge variant="secondary" className="ml-1.5 text-[9px] h-4 px-1">
                        {frames.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                  {showDiskTab && (
                    <TabsTrigger value="disk" className="text-[11px] h-7 px-2 font-medium">
                      <HardDrive className="h-3 w-3 mr-1.5" />
                      Disk
                    </TabsTrigger>
                  )}
                  <TabsTrigger value="scripts" className="text-[11px] h-7 px-2 font-medium">
                    <Terminal className="h-3 w-3 mr-1.5" />
                    Scripts
                    {(scriptLogs.length > 0 || (tests && tests.length > 0)) && (
                      <span className="ml-1.5 flex items-center gap-1">
                        {scriptLogs.length > 0 && (
                          <Badge variant="secondary" className="text-[9px] h-4 px-1">
                            {scriptLogs.length}
                          </Badge>
                        )}
                        {tests && tests.length > 0 && (
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-[9px] h-4 px-1',
                              failedTests > 0
                                ? 'bg-red-500/10 text-red-400 border-red-500/30'
                                : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                            )}
                          >
                            {passedTests}/{tests.length}
                          </Badge>
                        )}
                      </span>
                    )}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            )}
          </div>

          <div className="flex items-center gap-2">
            {isExpanded && activeTab === 'network' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer select-none">
                    <Switch
                      checked={preserveOnSend}
                      onCheckedChange={setPreserveOnSend}
                      className="h-3.5 w-7 data-[state=checked]:bg-primary/80"
                      aria-label="Preserve log across requests"
                    />
                    <span>Preserve log</span>
                  </label>
                </TooltipTrigger>
                <TooltipContent>
                  <p>When off, prior entries are cleared on each new send.</p>
                </TooltipContent>
              </Tooltip>
            )}

            {isExpanded && activeTab === 'network' && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={entries.length === 0}
                    className="h-5 w-5"
                    aria-label="Export entries"
                    title="Export entries"
                  >
                    <Download className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel className="text-[11px]">
                    Export all ({entries.length})
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => handleExport('har', 'all')}>
                    HAR 1.2 (.har)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExport('ndjson', 'all')}>
                    NDJSON (.ndjson)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExport('curl', 'all')}>
                    cURL batch (.sh)
                  </DropdownMenuItem>
                  {filtersActive && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-[11px]">
                        Export filtered ({filteredEntries.length})
                      </DropdownMenuLabel>
                      <DropdownMenuItem
                        disabled={filteredEntries.length === 0}
                        onClick={() => handleExport('har', 'filtered')}
                      >
                        HAR 1.2 (.har)
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={filteredEntries.length === 0}
                        onClick={() => handleExport('ndjson', 'filtered')}
                      >
                        NDJSON (.ndjson)
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={filteredEntries.length === 0}
                        onClick={() => handleExport('curl', 'filtered')}
                      >
                        cURL batch (.sh)
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {isExpanded && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleClear}
                    disabled={clearDisabled}
                    className="h-5 w-5"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Clear {CLEAR_LABELS[activeTab]}</p>
                </TooltipContent>
              </Tooltip>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setExpanded(!isExpanded)}
                  className="h-5 w-5"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronUp className="h-3 w-3" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{isExpanded ? 'Collapse' : 'Expand'} console (⌘⇧C)</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {isExpanded && <div className="flex-1 overflow-hidden">{renderActiveTab()}</div>}
      </div>
    </TooltipProvider>
  );
}
