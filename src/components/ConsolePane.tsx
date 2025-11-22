'use client';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Terminal, Trash2, CheckCircle2, XCircle, AlertCircle, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';
import { Stagger, StaggerItem } from '@/components/ui/motion';

interface ConsoleLog {
  type: 'log' | 'error' | 'warn' | 'info';
  message: string;
  timestamp: number;
}

interface ConsoleTest {
  name: string;
  passed: boolean;
  error?: string;
}

interface ConsolePaneProps {
  logs: ConsoleLog[];
  tests?: ConsoleTest[];
  onClear?: () => void;
}

export default function ConsolePane({ logs, tests, onClear }: ConsolePaneProps) {
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3
    });
  };

  const getLogIcon = (type: ConsoleLog['type']) => {
    switch (type) {
      case 'error':
        return <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" />;
      case 'warn':
        return <AlertCircle className="h-4 w-4 text-yellow-500 flex-shrink-0" />;
      case 'info':
        return <Info className="h-4 w-4 text-blue-500 flex-shrink-0" />;
      default:
        return <Terminal className="h-4 w-4 text-muted-foreground flex-shrink-0" />;
    }
  };

  const getLogColor = (type: ConsoleLog['type']) => {
    switch (type) {
      case 'error':
        return 'text-red-500';
      case 'warn':
        return 'text-yellow-500';
      case 'info':
        return 'text-blue-500';
      default:
        return 'text-foreground';
    }
  };

  const passedTests = tests?.filter(t => t.passed).length || 0;
  const failedTests = tests?.filter(t => !t.passed).length || 0;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-full border-t border-white/10 dark:border-white/5 shadow-glass-lg glass relative z-10">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-white/10 dark:border-white/5 bg-transparent shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-white/10 dark:bg-white/5">
              <Terminal className="h-4 w-4 text-slate-blue-500 dark:text-slate-blue-400" />
            </div>
            <span className="text-sm font-semibold tracking-tight">Console</span>
            {logs.length > 0 && (
              <Badge variant="secondary" className="bg-muted/50 text-muted-foreground">
                {logs.length} log{logs.length !== 1 ? 's' : ''}
              </Badge>
            )}
            {tests && tests.length > 0 && (
              <>
                <Separator orientation="vertical" className="h-5 bg-slate-blue-500/20" />
                <div className="flex items-center gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="outline" className="bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30 cursor-help">
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                        {passedTests} passed
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{passedTests} test{passedTests !== 1 ? 's' : ''} passed successfully</p>
                    </TooltipContent>
                  </Tooltip>
                  {failedTests > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="outline" className="bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30 cursor-help">
                          <XCircle className="h-3 w-3 mr-1" />
                          {failedTests} failed
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{failedTests} test{failedTests !== 1 ? 's' : ''} failed</p>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onClear}
                disabled={logs.length === 0}
                className="hover:bg-white/10 dark:hover:bg-white/5 hover:text-slate-blue-600 dark:hover:text-slate-blue-400 transition-colors"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Clear
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Clear console output</p>
            </TooltipContent>
          </Tooltip>
        </div>

      {/* Console Content */}
      <ScrollArea className="flex-1">
        <div className="p-4 font-mono text-xs space-y-2">
          {logs.length === 0 && !tests ? (
            <div className="text-muted-foreground text-center py-12">
              <Terminal className="mx-auto h-12 w-12 mb-3 opacity-30" />
              <p className="font-medium">No console output</p>
              <p className="text-xs mt-1">Logs and test results will appear here</p>
            </div>
          ) : (
            <>
              {/* Test Results */}
              {tests && tests.length > 0 && (
                <div className="mb-4">
                  <div className="text-muted-foreground font-semibold mb-3 flex items-center gap-2">
                    <div className="h-1 w-1 rounded-full bg-primary" />
                    Test Results
                  </div>
                  <Stagger className="space-y-2">
                  {tests.map((test, index) => (
                    <StaggerItem
                      key={index}
                      className={`flex items-start gap-3 p-3 rounded-lg border transition-all ${
                        test.passed
                          ? 'bg-green-500/5 border-green-500/20 hover:bg-green-500/10'
                          : 'bg-red-500/5 border-red-500/20 hover:bg-red-500/10'
                      }`}
                    >
                      {test.passed ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0 mt-0.5" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className={`font-medium ${test.passed ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                          {test.name}
                        </div>
                        {test.error && (
                          <div className="text-red-500 text-xs mt-1.5 pl-2 border-l-2 border-red-500/30">
                            {test.error}
                          </div>
                        )}
                      </div>
                    </StaggerItem>
                  ))}
                  </Stagger>
                </div>
              )}

              {/* Console Logs */}
              <Stagger show={logs.length > 0}>
              {logs.map((log, index) => (
                <StaggerItem
                  key={index}
                  className="flex items-start gap-3 p-2.5 rounded-lg hover:bg-primary/5 transition-all border border-transparent hover:border-primary/10"
                >
                  {getLogIcon(log.type)}
                  <span className="text-muted-foreground text-[10px] font-medium flex-shrink-0 mt-0.5 px-2 py-0.5 rounded bg-muted/50">
                    {formatTime(log.timestamp)}
                  </span>
                  <pre className={`flex-1 whitespace-pre-wrap break-words ${getLogColor(log.type)} leading-relaxed`}>
                    {log.message}
                  </pre>
                </StaggerItem>
              ))}
              </Stagger>
            </>
          )}
        </div>
      </ScrollArea>
      </div>
    </TooltipProvider>
  );
}
