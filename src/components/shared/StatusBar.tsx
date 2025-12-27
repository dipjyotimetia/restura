'use client';

import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useRequestStore } from '@/store/useRequestStore';
import { Clock, Wifi, WifiOff, Activity } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/shared/utils';

// Helper to format relative time
const formatRelativeTime = (timestamp: number): string => {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleTimeString();
};

export default function StatusBar() {
  const { activeEnvironmentId, environments } = useEnvironmentStore();
  const { history } = useHistoryStore();
  const { isLoading, currentResponse } = useRequestStore();
  const [isOnline, setIsOnline] = useState(true);
  const [lastActivityTime, setLastActivityTime] = useState<string>('');

  // Monitor online status
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

  // Update last activity time
  useEffect(() => {
    if (currentResponse?.timestamp) {
      const date = new Date(currentResponse.timestamp);
      setLastActivityTime(date.toLocaleTimeString());
    }
  }, [currentResponse]);

  const activeEnv = environments.find((e) => e.id === activeEnvironmentId);
  const todayRequests = history.filter((h) => {
    const today = new Date();
    const requestDate = new Date(h.timestamp);
    return requestDate.toDateString() === today.toDateString();
  }).length;

  return (
    <TooltipProvider delayDuration={200}>
      <footer
        className="h-8 bg-gradient-to-r from-surface-1 via-surface-2 to-surface-1 border-t border-border/40 flex items-center justify-between px-4 text-xs text-muted-foreground select-none backdrop-blur-sm"
        role="status"
        aria-live="polite"
        aria-label="Application status bar"
      >
        {/* Left section */}
        <div className="flex items-center gap-4">
          {/* Environment indicator with colored dot */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 cursor-default hover:text-foreground transition-colors">
                <span className={cn(
                  "h-2 w-2 rounded-full",
                  activeEnv ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/40"
                )} />
                <span className="font-medium">
                  {activeEnv?.name || 'No Environment'}
                </span>
                {activeEnv && (
                  <span className="text-muted-foreground/60">
                    ({activeEnv.variables.filter((v) => v.enabled).length} vars)
                  </span>
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>Active Environment</p>
            </TooltipContent>
          </Tooltip>

          <span className="h-3.5 w-px bg-border/40" />

          {/* Request count */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 cursor-default hover:text-foreground transition-colors">
                <Activity className="icon-sm" />
                <span className="tabular-nums font-medium">{todayRequests}</span>
                <span className="text-muted-foreground/60">today</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>Total requests made today</p>
            </TooltipContent>
          </Tooltip>

          {/* Last activity - relative time */}
          {lastActivityTime && (
            <>
              <span className="h-3.5 w-px bg-border/40" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1.5 cursor-default hover:text-foreground transition-colors">
                    <Clock className="icon-sm" />
                    <span className="text-muted-foreground/60">
                      {currentResponse?.timestamp
                        ? formatRelativeTime(currentResponse.timestamp)
                        : lastActivityTime}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>Last request: {lastActivityTime}</p>
                </TooltipContent>
              </Tooltip>
            </>
          )}
        </div>

        {/* Right section */}
        <div className="flex items-center gap-4">
          {/* Loading indicator */}
          {isLoading && (
            <>
              <div className="flex items-center gap-1.5 text-amber-500 font-medium">
                <span className="h-2 w-2 rounded-full bg-current animate-pulse" />
                <span>Sending...</span>
              </div>
              <span className="h-3.5 w-px bg-border/40" />
            </>
          )}

          {/* Response status with glow */}
          {currentResponse && !isLoading && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className={cn(
                      'flex items-center gap-1.5 cursor-default font-mono font-semibold tabular-nums px-2 py-0.5 rounded-md border transition-all',
                      currentResponse.status >= 200 && currentResponse.status < 300
                        ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20 glow-success'
                        : currentResponse.status >= 400
                          ? 'text-red-500 bg-red-500/10 border-red-500/20 glow-destructive'
                          : 'text-amber-500 bg-amber-500/10 border-amber-500/20 glow-warning'
                    )}
                  >
                    <span>{currentResponse.status}</span>
                    <span className="text-muted-foreground/60">|</span>
                    <span>{currentResponse.time}ms</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>Last response: {currentResponse.statusText}</p>
                </TooltipContent>
              </Tooltip>
              <span className="h-3.5 w-px bg-border/40" />
            </>
          )}

          {/* Connection status */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  'flex items-center gap-1.5 cursor-default transition-colors',
                  isOnline ? 'text-emerald-500' : 'text-red-500'
                )}
              >
                {isOnline ? <Wifi className="icon-sm" /> : <WifiOff className="icon-sm" />}
                <span className="text-[11px] uppercase tracking-wide font-medium">
                  {isOnline ? 'Online' : 'Offline'}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{isOnline ? 'Internet connection available' : 'No internet connection'}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </footer>
    </TooltipProvider>
  );
}
