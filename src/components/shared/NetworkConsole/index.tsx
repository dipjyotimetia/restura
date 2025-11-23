'use client';

import { useEffect, useCallback, useRef } from 'react';
import { useConsoleStore, ConsoleLog, ConsoleTest } from '@/store/useConsoleStore';
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

  const isDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Handle resize
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleResizeMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current) return;

    const windowHeight = window.innerHeight;
    const mouseY = e.clientY;
    const newHeight = windowHeight - mouseY;

    // Clamp between 100px and 50% of viewport
    const clampedHeight = Math.min(windowHeight * 0.5, Math.max(100, newHeight));
    setPanelHeight(clampedHeight);
  }, [setPanelHeight]);

  const handleResizeEnd = useCallback(() => {
    isDragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleResizeMove);
    window.addEventListener('mouseup', handleResizeEnd);

    return () => {
      window.removeEventListener('mousemove', handleResizeMove);
      window.removeEventListener('mouseup', handleResizeEnd);
    };
  }, [handleResizeMove, handleResizeEnd]);

  // Keyboard shortcut for toggling console
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + Shift + C to toggle console
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'c') {
        e.preventDefault();
        setExpanded(!isExpanded);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isExpanded, setExpanded]);

  const handleClear = () => {
    if (activeTab === 'network') {
      clearEntries();
    } else {
      onClearScripts?.();
    }
  };

  const passedTests = tests?.filter((t) => t.passed).length || 0;
  const failedTests = tests?.filter((t) => !t.passed).length || 0;

  return (
    <TooltipProvider delayDuration={300}>
      <div
        ref={containerRef}
        className="flex flex-col border-t border-border shadow-lg bg-background relative z-10"
        style={{ height: isExpanded ? panelHeight : 36 }}
      >
        {/* Resize handle */}
        {isExpanded && (
          <div
            className="absolute -top-1.5 left-0 right-0 h-3 cursor-row-resize z-20 flex items-center justify-center group"
            onMouseDown={handleResizeStart}
          >
            <div className="h-1 w-8 rounded-full bg-border group-hover:bg-primary/50 transition-colors" />
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between px-3 h-9 border-b border-border bg-muted/50 shrink-0">
          <div className="flex items-center gap-2">
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'network' | 'scripts')}>
              <TabsList className="h-7 p-0.5 bg-transparent">
                <TabsTrigger
                  value="network"
                  className="text-xs h-6 px-2 data-[state=active]:bg-background data-[state=active]:shadow-sm"
                >
                  <Network className="h-3 w-3 mr-1.5" />
                  Network
                  {entries.length > 0 && (
                    <Badge variant="secondary" className="ml-1.5 text-[10px] h-4 px-1">
                      {entries.length}
                    </Badge>
                  )}
                </TabsTrigger>
                <TabsTrigger
                  value="scripts"
                  className="text-xs h-6 px-2 data-[state=active]:bg-background data-[state=active]:shadow-sm"
                >
                  <Terminal className="h-3 w-3 mr-1.5" />
                  Scripts
                  {(scriptLogs.length > 0 || (tests && tests.length > 0)) && (
                    <span className="ml-1.5 flex items-center gap-1">
                      {scriptLogs.length > 0 && (
                        <Badge variant="secondary" className="text-[10px] h-4 px-1">
                          {scriptLogs.length}
                        </Badge>
                      )}
                      {tests && tests.length > 0 && (
                        <Badge
                          variant="outline"
                          className={cn(
                            'text-[10px] h-4 px-1',
                            failedTests > 0
                              ? 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30'
                              : 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30'
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
          </div>

          <div className="flex items-center gap-1">
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
                  className="h-6 w-6"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Clear {activeTab === 'network' ? 'network logs' : 'console'}</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setExpanded(!isExpanded)}
                  className="h-6 w-6"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronUp className="h-3.5 w-3.5" />
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
              <ScriptsTab logs={scriptLogs} tests={tests} />
            )}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
