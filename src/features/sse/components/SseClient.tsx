import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import AuthConfiguration from '@/features/auth/components/AuthConfig';
import { buildAuthCredential } from '@/features/auth/lib/buildAuthCredential';
import { sseManager } from '@/features/sse/lib/sseManager';
import { createSseStreamSummary, getSseSummaryView } from '@/features/sse/lib/streamSummary';
import { useSseStore } from '@/features/sse/store/useSseStore';
import { keyValuePairsToRecord } from '@/lib/shared/utils';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
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
 * All stream state still lives in `useSseStore` + `sseManager`. This file
 * only composes presentational pieces and derives display-time metrics
 * from the existing log.
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
  const {
    createConnection,
    updateConnectionUrl,
    setReconnectOnResume,
    clearLog,
    addHeader,
    updateHeader,
    removeHeader,
    setAuth,
    setSearchQuery,
    setEventNameFilter,
    searchQuery,
    getFilteredLog,
  } = useSseStore(
    useShallow((s) => ({
      createConnection: s.createConnection,
      updateConnectionUrl: s.updateConnectionUrl,
      setReconnectOnResume: s.setReconnectOnResume,
      clearLog: s.clearLog,
      addHeader: s.addHeader,
      updateHeader: s.updateHeader,
      removeHeader: s.removeHeader,
      setAuth: s.setAuth,
      setSearchQuery: s.setSearchQuery,
      setEventNameFilter: s.setEventNameFilter,
      searchQuery: s.searchQuery,
      getFilteredLog: s.getFilteredLog,
    }))
  );
  const resolveVariables = useEnvironmentStore((s) => s.resolveVariables);

  // Auto-create a default connection on first mount if none exist
  useEffect(() => {
    if (!hasConnections) {
      createConnection();
    }
  }, [hasConnections, createConnection]);

  const filtered = useMemo(
    () => (active ? getFilteredLog(active.id) : []),
    [active, getFilteredLog]
  );

  // Tear down any open stream when the component unmounts.
  const activeIdForCleanup = active?.id;
  useEffect(() => {
    return () => {
      if (activeIdForCleanup) sseManager.disconnect(activeIdForCleanup);
    };
  }, [activeIdForCleanup]);

  const [headersOpen, setHeadersOpen] = useState(false);

  const isConnected = active?.status === 'connected';
  const isConnecting = active?.status === 'connecting' || active?.status === 'reconnecting';
  const isStreaming = isConnected || isConnecting;

  const handleConnect = () => {
    if (!active) return;
    const headers = keyValuePairsToRecord(active.headers);
    const resolvedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) resolvedHeaders[k] = resolveVariables(v);

    // Header-based auth (basic/bearer/api-key/oauth2). Sign-at-wire types
    // (sigv4/oauth1/wsse) aren't applied to SSE streams — buildAuthCredential
    // no-ops them and the SSE handler doesn't sign.
    const credential = buildAuthCredential(active.auth);
    for (const [k, v] of Object.entries(credential.headers))
      resolvedHeaders[k] = resolveVariables(v);

    let url = resolveVariables(active.url);
    if (Object.keys(credential.params).length > 0) {
      try {
        const u = new URL(url);
        for (const [k, v] of Object.entries(credential.params))
          u.searchParams.set(k, resolveVariables(v));
        url = u.toString();
      } catch {
        // Leave the URL untouched if it isn't yet a valid absolute URL;
        // sseManager.connect surfaces the validation error.
      }
    }

    sseManager.connect(active.id, url, resolvedHeaders);
  };

  const handleDisconnect = () => {
    if (!active) return;
    sseManager.disconnect(active.id);
  };

  const derived = useMemo(() => getSseSummaryView(summary), [summary]);

  if (!active) return null;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-transparent">
      <SseUrlBar
        url={active.url}
        onUrlChange={(v) => updateConnectionUrl(active.id, v)}
        isStreaming={isConnected}
        isConnecting={isConnecting}
        onStream={handleConnect}
        onStop={handleDisconnect}
        headerCount={active.headers.length}
        headersOpen={headersOpen}
        onToggleHeaders={() => setHeadersOpen((s) => !s)}
      />

      {headersOpen && (
        <div className="border-b border-sp-line p-3 bg-sp-surface-lo">
          <KeyValueEditor
            items={active.headers}
            onAdd={() => addHeader(active.id)}
            onUpdate={(id, updates) => updateHeader(active.id, id, updates)}
            onDelete={(id) => removeHeader(active.id, id)}
            keyPlaceholder="Header name"
            valuePlaceholder="Header value"
            addButtonText="Add header"
          />
          <div className="pt-3 mt-3 border-t border-sp-line">
            <Label className="text-sp-11 text-sp-muted mb-2 block">Auth</Label>
            <AuthConfiguration auth={active.auth} onChange={(a) => setAuth(active.id, a)} />
          </div>
          <div className="flex items-center gap-2 pt-3 mt-3 border-t border-sp-line">
            <Switch
              id="resume"
              checked={active.reconnectOnResume}
              onCheckedChange={(c) => setReconnectOnResume(active.id, c)}
            />
            <Label htmlFor="resume" className="text-sp-11 text-sp-muted">
              Reconnect on resume (Last-Event-ID)
            </Label>
          </div>
        </div>
      )}

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
          eventNameFilter={active.eventNameFilter}
          onEventNameFilterChange={(v) => setEventNameFilter(active.id, v)}
          eventNames={derived.eventNames}
          onClearLog={() => clearLog(active.id)}
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
}
