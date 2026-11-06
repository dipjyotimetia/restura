import { useState } from 'react';
import { ResponseTestsPanel } from '@/components/shared/ResponseTestsPanel';
import { LayoutToggleButton } from '@/components/shared/ResponseToolbarButtons';
import { StreamingResponseViewer } from '@/components/shared/StreamingResponseViewer';
import { Button } from '@/components/ui/button';
import { Floater, type SubTab, SubTabBar } from '@/components/ui/spatial';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { HttpStreamEvent } from '@/features/http/lib/streamingResponseReader';
import { useActiveStreamStore } from '@/features/http/store/useActiveStreamStore';
import { useActiveTab } from '@/store/selectors';

type StreamTab = 'stream' | 'tests';

/**
 * The response panel for a streamed HTTP send: the live event list, and the
 * test script's results once the stream has ended (the send runs its test
 * script against the captured stream text, like a buffered send).
 */
export function StreamingResponsePanel({ events }: { events: AsyncIterable<HttpStreamEvent> }) {
  const [tab, setTab] = useState<StreamTab>('stream');
  const activeTab = useActiveTab();
  const testResult = activeTab?.scriptResult?.test;
  const tabId = activeTab?.id;
  const running = useActiveStreamStore((s) => (tabId ? Boolean(s.cancels[tabId]) : false));
  const stop = useActiveStreamStore((s) => s.stop);
  const tests = testResult?.tests ?? [];
  const tabs: ReadonlyArray<SubTab<StreamTab>> = [
    { value: 'stream', label: 'Stream' },
    {
      value: 'tests',
      label: 'Tests',
      ...(tests.length > 0 && {
        badge: `${tests.filter((t) => t.passed).length}/${tests.length}`,
      }),
    },
  ];
  return (
    <TooltipProvider delayDuration={300}>
      <Floater
        radius="panel"
        elevation="float-lg"
        className="h-full flex flex-col overflow-hidden relative z-20"
      >
        <div className="h-11 flex items-center px-3 border-b border-sp-line">
          <span className="sp-label">Streaming response</span>
          <div className="flex-1" />
          {running && tabId && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 mr-2"
              onClick={() => stop(tabId)}
              aria-label="Stop stream"
            >
              Stop
            </Button>
          )}
          <LayoutToggleButton />
        </div>
        <SubTabBar tabs={tabs} value={tab} onChange={setTab} />
        {/* Kept mounted on the Tests tab so the event list keeps its place. */}
        <div className={tab === 'stream' ? 'flex-1 min-h-0' : 'hidden'}>
          <StreamingResponseViewer events={events} />
        </div>
        {tab === 'tests' && (
          <div className="flex-1 min-h-0">
            <ResponseTestsPanel result={testResult} />
          </div>
        )}
      </Floater>
    </TooltipProvider>
  );
}
