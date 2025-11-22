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
        className="h-6 bg-gradient-to-r from-slate-blue-900/90 to-indigo-900/90 border-t border-slate-blue-500/20 flex items-center justify-between px-3 text-xs text-slate-300 select-none"
        role="status"
        aria-live="polite"
        aria-label="Application status bar"
      >
        {/* Left section */}
        <div className="flex items-center gap-4">
          {/* Environment indicator */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 cursor-default">
                <Globe className="h-3 w-3 text-slate-blue-400" />
                <span className="font-medium">
                  {activeEnv?.name || 'No Environment'}
                </span>
                {activeEnv && (
                  <span className="text-slate-500">
                    ({activeEnv.variables.filter((v) => v.enabled).length} vars)
                  </span>
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>Active Environment</p>
            </TooltipContent>
          </Tooltip>

          {/* Request count */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 cursor-default">
                <Database className="h-3 w-3 text-slate-blue-400" />
                <span>{todayRequests} requests today</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>Total requests made today</p>
            </TooltipContent>
          </Tooltip>

          {/* Last activity */}
          {lastActivityTime && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1.5 cursor-default">
                  <Clock className="h-3 w-3 text-slate-blue-400" />
                  <span>Last: {lastActivityTime}</span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>Last request time</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Right section */}
        <div className="flex items-center gap-4">
          {/* Loading indicator */}
          {isLoading && (
            <div className="flex items-center gap-1.5 text-amber-400 animate-pulse">
              <Circle className="h-2 w-2 fill-current" />
              <span>Sending...</span>
            </div>
          )}

          {/* Connection status */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  'flex items-center gap-1.5 cursor-default',
                  isOnline ? 'text-emerald-400' : 'text-red-400'
                )}
              >
                {isOnline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                <span>{isOnline ? 'Online' : 'Offline'}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{isOnline ? 'Internet connection available' : 'No internet connection'}</p>
            </TooltipContent>
          </Tooltip>

          {/* Response status */}
          {currentResponse && !isLoading && (
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className={cn(
                    'flex items-center gap-1.5 cursor-default',
                    currentResponse.status >= 200 && currentResponse.status < 300
                      ? 'text-emerald-400'
                      : currentResponse.status >= 400
                        ? 'text-red-400'
                        : 'text-yellow-400'
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
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
