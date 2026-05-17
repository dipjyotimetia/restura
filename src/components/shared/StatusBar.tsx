import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useRequestStore } from '@/store/useRequestStore';
import { selectActiveEnvironment, useActiveResponse } from '@/store/selectors';
import { Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/shared/utils';

const getStatusTextColor = (status: number) => {
  if (status >= 200 && status < 300) return 'text-emerald-400';
  if (status >= 300 && status < 400) return 'text-blue-400';
  if (status >= 400 && status < 500) return 'text-amber-400';
  if (status >= 500) return 'text-destructive';
  return 'text-muted-foreground';
};

export default function StatusBar() {
  const activeEnv = useEnvironmentStore(selectActiveEnvironment);
  const isLoading = useRequestStore((s) => s.isLoading);
  const currentResponse = useActiveResponse();
  const todayRequests = useHistoryStore((state) => {
    const todayStr = new Date().toDateString();
    return state.history.filter((h) => new Date(h.timestamp).toDateString() === todayStr).length;
  });
  const [isOnline, setIsOnline] = useState(true);
  const [showPaletteHint, setShowPaletteHint] = useState(() => window.innerWidth > 720);

  useEffect(() => {
    const updateOnlineStatus = () => setIsOnline(navigator.onLine);
    const updateHint = () =>
      setShowPaletteHint((prev) => {
        const next = window.innerWidth > 720;
        return prev === next ? prev : next;
      });
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    window.addEventListener('resize', updateHint);
    updateOnlineStatus();
    return () => {
      window.removeEventListener('online', updateOnlineStatus);
      window.removeEventListener('offline', updateOnlineStatus);
      window.removeEventListener('resize', updateHint);
    };
  }, []);

  const triggerCommandPalette = () => {
    const event = new KeyboardEvent('keydown', {
      key: 'k',
      metaKey: true,
      ctrlKey: true,
      bubbles: true,
    });
    document.dispatchEvent(event);
  };

  const lastActivityTime = currentResponse?.timestamp
    ? new Date(currentResponse.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className="h-7 glass-1 glass-border-default border-t flex items-center justify-between px-4 text-xs font-mono text-muted-foreground select-none shrink-0"
        role="status"
        aria-live="polite"
        aria-label="Application status bar"
      >
        {/* Left section */}
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 hover:text-foreground transition-colors cursor-default">
                {activeEnv && (
                  <div className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                )}
                <span>{activeEnv?.name ?? 'No Environment'}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>Active environment{activeEnv ? ` · ${activeEnv.variables.filter((v) => v.enabled).length} vars` : ''}</p>
            </TooltipContent>
          </Tooltip>

          <span className="text-muted-foreground/30" aria-hidden="true">·</span>

          <Tooltip>
            <TooltipTrigger asChild>
              <span className="hover:text-foreground transition-colors cursor-default">
                {todayRequests} requests
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>Requests made today</p>
            </TooltipContent>
          </Tooltip>

          {lastActivityTime && (
            <>
              <span className="text-muted-foreground/30" aria-hidden="true">·</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="hover:text-foreground transition-colors cursor-default">
                    {lastActivityTime}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>Last request time</p>
                </TooltipContent>
              </Tooltip>
            </>
          )}
        </div>

        {/* Right section */}
        <div className="flex items-center gap-2">
          {isLoading && (
            <>
              <div className="flex items-center gap-1.5 text-amber-400">
                <div className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" aria-hidden="true" />
                <span>Sending...</span>
              </div>
              <span className="text-muted-foreground/30" aria-hidden="true">·</span>
            </>
          )}

          {currentResponse && !isLoading && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className={cn('flex items-center gap-1.5 cursor-default', getStatusTextColor(currentResponse.status))}>
                    <div className={cn('h-1.5 w-1.5 rounded-full bg-current')} aria-hidden="true" />
                    <span>{currentResponse.status} · {currentResponse.time}ms</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>Last response: {currentResponse.statusText}</p>
                </TooltipContent>
              </Tooltip>
              <span className="text-muted-foreground/30" aria-hidden="true">·</span>
            </>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <div className={cn('flex items-center gap-1 cursor-default transition-colors', isOnline ? 'text-emerald-400' : 'text-destructive')}>
                {isOnline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{isOnline ? 'Online' : 'Offline'}</p>
            </TooltipContent>
          </Tooltip>

          {showPaletteHint && (
            <>
              <span className="text-muted-foreground/30" aria-hidden="true">·</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={triggerCommandPalette}
                    className="flex items-center gap-1.5 hover:text-foreground transition-colors focus:outline-none focus-visible:text-foreground"
                    aria-label="Open command palette"
                  >
                    <Kbd className="h-4 text-[10px]">⌘K</Kbd>
                    <span>Palette</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>Open command palette (⌘K)</p>
                </TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
