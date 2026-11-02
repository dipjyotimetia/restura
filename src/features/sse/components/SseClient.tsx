import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { KeyValueTable } from '@/components/shared/KeyValueTable';
import { StreamSplit } from '@/components/shared/StreamSplit';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import AuthConfiguration from '@/features/auth/components/AuthConfig';
import { sseExportName } from '@/features/sse/lib/sseLogExport';
import { sseManager } from '@/features/sse/lib/sseManager';
import { createSseStreamSummary, getSseSummaryView } from '@/features/sse/lib/streamSummary';
import { useSseStore } from '@/features/sse/store/useSseStore';
import { useSendShortcut } from '@/hooks/useSendShortcut';
import { resolveSseConnect } from '@/lib/shared/connectSpec';
import { useActiveRequest, useActiveTabId } from '@/store/selectors';
import { useRequestStore } from '@/store/useRequestStore';
import type { SseRequest } from '@/types';
import SseAssembledOutput from './SseAssembledOutput';
import SseCounters from './SseCounters';
import SseEventTimeline from './SseEventTimeline';
import SseStatsRow from './SseStatsRow';
import SseUrlBar from './SseUrlBar';

const EMPTY_SUMMARY = createSseStreamSummary();

/**
 * SSE view — Spatial Depth redesign.
 *
 * Layout:
 *   UrlBar
 *   StatsRow
 *   ┌────────────────────────────┐ ┌────────────────────┐
 *   │ Event timeline (flex: 1.4) │ │ Assembled output   │
 *   │                            │ │ Counters (2×2)     │
 *   └────────────────────────────┘ └────────────────────┘
 *
 * Request config (url, headers, params, auth, event filter, reconnect on
 * resume) lives on the active tab's `SseRequest` and is edited through
 * `useRequestStore.updateRequest` — exactly like the HTTP/gRPC builders — so
 * Save to Collection persists what the user configured and opening a saved
 * item hydrates the builder. `useSseStore` + `sseManager` keep only the
 * runtime stream state (status, log, Last-Event-ID).
 */
export default function SseClient() {
  const activeConnectionId = useSseStore((s) => s.activeConnectionId);
  const active = useSseStore((s) =>
    activeConnectionId ? (s.connections[activeConnectionId] ?? null) : null
  );
  const summary = useSseStore((s) =>
    activeConnectionId ? (s.summaries[activeConnectionId] ?? EMPTY_SUMMARY) : EMPTY_SUMMARY
  );
  const hasConnections = useSseStore((s) => Object.keys(s.connections).length > 0);
  const { createConnection, clearLog, setSearchQuery, searchQuery, getFilteredLog } = useSseStore(
    useShallow((s) => ({
      createConnection: s.createConnection,
      clearLog: s.clearLog,
      setSearchQuery: s.setSearchQuery,
      searchQuery: s.searchQuery,
      getFilteredLog: s.getFilteredLog,
    }))
  );
  const request = useActiveRequest('sse');
  const activeTabId = useActiveTabId();
  const updateRequest = useRequestStore((s) => s.updateRequest);
  const update = (patch: Partial<SseRequest>) => updateRequest(patch);
  const eventNameFilter = request?.eventFilter?.[0] ?? 'all';

  // Auto-create a default connection on first mount if none exist
  useEffect(() => {
    if (!hasConnections) {
      createConnection();
    }
  }, [hasConnections, createConnection]);

  const filtered = useMemo(
    () => (active ? getFilteredLog(active.id, eventNameFilter) : []),
    [active, getFilteredLog, eventNameFilter]
  );

  // Tear down any open stream when the component unmounts or the user moves
  // to another SSE tab — the stream was opened with the previous tab's config.
  const activeIdForCleanup = active?.id;
  useEffect(() => {
    return () => {
      if (activeIdForCleanup) sseManager.disconnect(activeIdForCleanup);
    };
  }, [activeIdForCleanup, activeTabId]);

  const [headersOpen, setHeadersOpen] = useState(false);

  const isConnected = active?.status === 'connected';
  const isConnecting = active?.status === 'connecting' || active?.status === 'reconnecting';
  const isStreaming = isConnected || isConnecting;

  const handleConnect = () => {
    if (!active || !request) return;
    const spec = resolveSseConnect(request);
    if (!spec.ok) {
      useSseStore.getState().appendSystem(active.id, `Connection failed: ${spec.error}`);
      return;
    }

    sseManager.connect(active.id, spec.url, spec.headers, {
      reconnectOnResume: request.reconnectOnResume ?? true,
      autoReconnect: request.autoReconnect ?? true,
      ...(spec.stripOnOriginChange.length > 0
        ? { stripOnOriginChange: spec.stripOnOriginChange }
        : {}),
    });
  };

  const handleDisconnect = () => {
    if (!active) return;
    sseManager.disconnect(active.id);
  };

  const derived = useMemo(() => getSseSummaryView(summary), [summary]);
  // A filter restored from a saved request must stay selectable before any
  // matching event has arrived.
  const eventNames = useMemo(
    () =>
      eventNameFilter !== 'all' && !derived.eventNames.includes(eventNameFilter)
        ? [eventNameFilter, ...derived.eventNames]
        : derived.eventNames,
    [derived.eventNames, eventNameFilter]
  );

  const sendShortcut = useSendShortcut();
  if (!active || !request) return null;

  sendShortcut.current = !isStreaming && request.url.trim() ? handleConnect : null;

  // Headers / auth / resume options; when open they get a resizable pane
  // above the log instead of pushing it down.
  const configPanel = (
    <div className="h-full overflow-auto p-3 bg-sp-surface-lo">
      <KeyValueTable
        items={request.headers}
        onChange={(headers) => update({ headers })}
        itemLabel="header"
        addLabel="Add header"
        resolvesVariables="request"
        httpHeaders
      />
      <div className="pt-3 mt-3 border-t border-sp-line">
        <Label className="text-sp-11 text-sp-muted mb-2 block">Query params</Label>
        <KeyValueTable
          items={request.params}
          onChange={(params) => update({ params })}
          itemLabel="param"
          addLabel="Add param"
          resolvesVariables="request"
        />
      </div>
      <div className="pt-3 mt-3 border-t border-sp-line">
        <Label className="text-sp-11 text-sp-muted mb-2 block">Auth</Label>
        <AuthConfiguration auth={request.auth} onChange={(auth) => update({ auth })} />
      </div>
      <div className="flex items-center gap-2 pt-3 mt-3 border-t border-sp-line">
        <Switch
          id="resume"
          checked={request.reconnectOnResume ?? true}
          onCheckedChange={(reconnectOnResume) => update({ reconnectOnResume })}
        />
        <Label htmlFor="resume" className="text-sp-11 text-sp-muted">
          Reconnect on resume (Last-Event-ID)
        </Label>
      </div>
      <div className="flex items-center gap-2 pt-2">
        <Switch
          id="auto-reconnect"
          checked={request.autoReconnect ?? true}
          onCheckedChange={(autoReconnect) => update({ autoReconnect })}
        />
        <Label htmlFor="auto-reconnect" className="text-sp-11 text-sp-muted">
          Auto-reconnect (honours server retry)
        </Label>
      </div>
    </div>
  );

  const logPanel = (
    <div className="flex min-h-0 flex-1 flex-col h-full">
      <SseStatsRow
        status={active.status}
        events={derived.eventCount}
        lastEventId={active.lastEventId}
        avgGapMs={derived.avgGapMs}
        reconnects={active.reconnectAttempts}
      />

      <div className="flex-1 min-h-0 grid gap-2.5 p-3" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
        <SseEventTimeline
          log={filtered}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          eventNameFilter={eventNameFilter}
          onEventNameFilterChange={(v) =>
            update(v === 'all' ? { eventFilter: undefined } : { eventFilter: [v] })
          }
          eventNames={eventNames}
          onClearLog={() => clearLog(active.id)}
          exportName={sseExportName(request.url)}
        />
        <div className="flex flex-col gap-2.5 min-h-0">
          <SseAssembledOutput
            text={derived.assembledText}
            progress={derived.progress}
            phases={derived.phases}
            isStreaming={isStreaming}
          />
          <SseCounters
            events={derived.eventCount}
            bytes={derived.bytes}
            tokens={derived.tokenCount}
            reconnects={active.reconnectAttempts}
          />
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden bg-transparent">
      <SseUrlBar
        url={request.url}
        onUrlChange={(url) => update({ url })}
        isStreaming={isConnected}
        isConnecting={isConnecting}
        onStream={handleConnect}
        onStop={handleDisconnect}
        headerCount={request.headers.length}
        headersOpen={headersOpen}
        onToggleHeaders={() => setHeadersOpen((s) => !s)}
      />

      {headersOpen ? <StreamSplit config={configPanel} log={logPanel} /> : logPanel}
    </div>
  );
}
