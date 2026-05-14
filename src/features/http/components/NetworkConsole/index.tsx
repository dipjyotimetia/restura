import { useEffect, useCallback, useRef } from 'react';
import type { ConsoleLog, ConsoleTest } from '@/store/useConsoleStore';
import { useConsoleStore } from '@/store/useConsoleStore';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Network, Terminal, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/shared/utils';
import NetworkTab from './NetworkTab';
import ScriptsTab from './ScriptsTab';

interface NetworkConsoleProps {
  scriptLogs?: ConsoleLog[];
  tests?: ConsoleTest[];
  onClearScripts?: () => void;
}

export default function NetworkConsole({ scriptLogs = [], tests, onClearScripts }: NetworkConsoleProps) {
  const {
    entries,
    isExpanded,
    panelHeight,
    activeTab,
    setExpanded,
    setPanelHeight,
    setActiveTab,
    clearEntries,
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
      const clampedHeight = Math.min(window.innerHeight * 0.4, Math.max(100, newHeight));
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
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'c') {
        e.preventDefault();
        setExpanded(!useConsoleStore.getState().isExpanded);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setExpanded]);

  const handleClear = () => {
    if (activeTab === 'network') {
      clearEntries();
    } else {
      onClearScripts?.();
    }
  };

  const passedTests = tests?.filter((t) => t.passed).length ?? 0;
  const failedTests = (tests?.length ?? 0) - passedTests;

  return (
    <TooltipProvider delayDuration={300}>
      <div
        ref={containerRef}
        className="flex flex-col border-t border-border bg-surface-2 relative z-10"
        style={{ height: isExpanded ? panelHeight : 24 }}
      >
        {/* Resize handle */}
        {isExpanded && (
          <div
            className="absolute -top-1.5 left-0 right-0 h-3 cursor-row-resize z-20 flex items-center justify-center group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onMouseDown={handleResizeStart}
            onKeyDown={(e) => {
              const step = 20;
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setPanelHeight(Math.min(window.innerHeight * 0.4, panelHeight + step));
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setPanelHeight(Math.max(100, panelHeight - step));
              }
            }}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize console panel"
            aria-valuenow={Math.round(panelHeight)}
            aria-valuemin={100}
            tabIndex={0}
          >
            <div className="h-1 w-8 rounded-full bg-border group-hover:bg-primary/50 transition-colors" />
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between px-3 h-6 shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/50 select-none">
              CONSOLE
            </span>
            {isExpanded && (
              <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'network' | 'scripts')}>
                <TabsList className="h-6 px-0 border-none bg-transparent gap-0">
                  <TabsTrigger value="network" className="text-[10px] h-6 px-2 font-mono">
                    <Network className="h-3 w-3 mr-1" />
                    Network
                    {entries.length > 0 && (
                      <Badge variant="secondary" className="ml-1 text-[9px] h-3.5 px-1">
                        {entries.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="scripts" className="text-[10px] h-6 px-2 font-mono">
                    <Terminal className="h-3 w-3 mr-1" />
                    Scripts
                    {(scriptLogs.length > 0 || (tests && tests.length > 0)) && (
                      <span className="ml-1 flex items-center gap-1">
                        {scriptLogs.length > 0 && (
                          <Badge variant="secondary" className="text-[9px] h-3.5 px-1">
                            {scriptLogs.length}
                          </Badge>
                        )}
                        {tests && tests.length > 0 && (
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-[9px] h-3.5 px-1',
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

          <div className="flex items-center gap-0.5">
            {isExpanded && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleClear}
                    disabled={
                      (activeTab === 'network' && entries.length === 0) ||
                      (activeTab === 'scripts' && scriptLogs.length === 0 && (!tests || tests.length === 0))
                    }
                    className="h-5 w-5"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Clear {activeTab === 'network' ? 'network logs' : 'console'}</p>
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

        {/* Content */}
        {isExpanded && (
          <div className="flex-1 overflow-hidden">
            {activeTab === 'network' ? (
              <NetworkTab />
            ) : (
              <ScriptsTab logs={scriptLogs} {...(tests !== undefined && { tests })} />
            )}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
