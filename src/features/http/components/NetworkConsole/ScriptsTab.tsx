'use client';

import { ScrollArea } from '@/components/ui/scroll-area';
import { Terminal, CheckCircle2, XCircle, AlertCircle, Info } from 'lucide-react';
import { Stagger, StaggerItem } from '@/components/ui/motion';
import { ConsoleLog, ConsoleTest } from '@/store/useConsoleStore';

interface ScriptsTabProps {
  logs: ConsoleLog[];
  tests?: ConsoleTest[];
}

const formatTime = (timestamp: number) => {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
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

export default function ScriptsTab({ logs, tests }: ScriptsTabProps) {
  if (logs.length === 0 && (!tests || tests.length === 0)) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-8">
        <Terminal className="h-10 w-10 mb-3 opacity-30" />
        <p className="font-medium text-sm">No console output</p>
        <p className="text-xs mt-1">Logs and test results will appear here</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-4 font-mono text-xs space-y-2">
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
                    <div
                      className={`font-medium ${
                        test.passed
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-red-600 dark:text-red-400'
                      }`}
                    >
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
              <pre
                className={`flex-1 whitespace-pre-wrap break-words ${getLogColor(log.type)} leading-relaxed`}
              >
                {log.message}
              </pre>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </ScrollArea>
  );
}
