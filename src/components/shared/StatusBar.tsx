'use client';

import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useRequestStore } from '@/store/useRequestStore';
import { Circle, Clock, Database, Globe, Wifi, WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/shared/utils';

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
      <div
        className="h-8 bg-gradient-to-r from-muted/80 via-muted to-muted/80 border-t border-border/60 flex items-center justify-between px-4 text-[11px] text-muted-foreground select-none backdrop-blur-sm shadow-inner"
        role="status"
        aria-live="polite"
        aria-label="Application status bar"
      >
        {/* Left section */}
        <div className="flex items-center gap-3">
          {/* Environment indicator */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 cursor-default hover:text-foreground transition-colors">
                <Globe className="h-3 w-3" />
                <span className="font-medium">
                  {activeEnv?.name || 'No Environment'}
                </span>
                {activeEnv && (
                  <span className="opacity-70">
                    ({activeEnv.variables.filter((v) => v.enabled).length} vars)
                  </span>
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>Active Environment</p>
            </TooltipContent>
          </Tooltip>

          <span className="h-3 w-px bg-border/60" />

          {/* Request count */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 cursor-default hover:text-foreground transition-colors">
                <Database className="h-3 w-3" />
                <span>{todayRequests} requests today</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>Total requests made today</p>
            </TooltipContent>
          </Tooltip>

          {/* Last activity */}
          {lastActivityTime && (
            <>
              <span className="h-3 w-px bg-border/60" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1.5 cursor-default hover:text-foreground transition-colors">
                    <Clock className="h-3 w-3" />
                    <span>Last: {lastActivityTime}</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>Last request time</p>
                </TooltipContent>
              </Tooltip>
            </>
          )}
        </div>

        {/* Right section */}
        <div className="flex items-center gap-3">
          {/* Loading indicator */}
          {isLoading && (
            <>
              <div className="flex items-center gap-1.5 text-amber-500 animate-pulse font-medium">
                <Circle className="h-2 w-2 fill-current" />
                <span>Sending...</span>
              </div>
              <span className="h-3 w-px bg-border/60" />
            </>
          )}

          {/* Response status */}
          {currentResponse && !isLoading && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className={cn(
                      'flex items-center gap-1.5 cursor-default font-medium',
                      currentResponse.status >= 200 && currentResponse.status < 300
                        ? 'text-emerald-500'
                        : currentResponse.status >= 400
                          ? 'text-red-500'
                          : 'text-amber-500'
                    )}
                  >
                    <Circle className="h-2 w-2 fill-current" />
                    <span>
                      {currentResponse.status} | {currentResponse.time}ms
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>Last response: {currentResponse.statusText}</p>
                </TooltipContent>
              </Tooltip>
              <span className="h-3 w-px bg-border/60" />
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
                {isOnline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                <span className="font-medium">{isOnline ? 'Online' : 'Offline'}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{isOnline ? 'Internet connection available' : 'No internet connection'}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}
