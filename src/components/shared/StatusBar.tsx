import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useRequestStore } from '@/store/useRequestStore';
import { selectActiveEnvironment } from '@/store/selectors';
import { useShallow } from 'zustand/react/shallow';
import { Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
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
  const { isLoading, currentResponse } = useRequestStore(
    useShallow((s) => ({ isLoading: s.isLoading, currentResponse: s.currentResponse }))
  );
  const todayRequests = useHistoryStore((state) => {
    const todayStr = new Date().toDateString();
    return state.history.filter((h) => new Date(h.timestamp).toDateString() === todayStr).length;
  });
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    const updateOnlineStatus = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    updateOnlineStatus();
    return () => {
      window.removeEventListener('online', updateOnlineStatus);
      window.removeEventListener('offline', updateOnlineStatus);
    };
  }, []);

  const lastActivityTime = currentResponse?.timestamp
    ? new Date(currentResponse.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className="h-6 bg-surface-2/80 backdrop-blur-sm border-t border-border flex items-center justify-between px-4 text-[10px] font-mono text-muted-foreground select-none shrink-0"
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
        </div>
      </div>
    </TooltipProvider>
  );
}
