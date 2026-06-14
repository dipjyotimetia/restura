import { useEffect, useMemo, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import { useSseStore } from '@/features/sse/store/useSseStore';
import { sseManager } from '@/features/sse/lib/sseManager';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { keyValuePairsToRecord } from '@/lib/shared/utils';
import AuthConfiguration from '@/features/auth/components/AuthConfig';
import { buildAuthCredential } from '@/features/auth/lib/buildAuthCredential';

import SseUrlBar from './SseUrlBar';
import SseStatsRow from './SseStatsRow';
import SseEventTimeline from './SseEventTimeline';
import SseAssembledOutput, { type SsePhase } from './SseAssembledOutput';
import SseCounters from './SseCounters';

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
  const {
    connections,
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
    getActiveConnection,
    getFilteredLog,
  } = useSseStore();
  const { resolveVariables } = useEnvironmentStore();

  // Auto-create a default connection on first mount if none exist
  useEffect(() => {
    if (Object.keys(connections).length === 0) {
      createConnection('');
    }
  }, [connections, createConnection]);

  const active = getActiveConnection();
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

  const eventNames = useMemo(() => {
    if (!active) return [] as string[];
    const set = new Set<string>();
    for (const e of active.log) if (e.kind === 'event') set.add(e.event);
    return Array.from(set).sort();
  }, [active]);

  // ─────────────────────────────────────────────────────────────────────
  // Derived display metrics — purely from the existing log. No store
  // changes; we treat the log as the source of truth.
  // ─────────────────────────────────────────────────────────────────────
  const derived = useMemo(() => {
    if (!active) {
      return {
        eventCount: 0,
        bytes: 0,
        tokenCount: 0,
        avgGapMs: null as number | null,
        assembledText: '',
        progress: null as number | null,
        phases: [] as SsePhase[],
      };
    }
    let bytes = 0;
    let tokenCount = 0;
    let eventCount = 0;
    let lastTs: number | null = null;
    const gaps: number[] = [];
    let assembledText = '';
    let progress: number | null = null;
    const phaseOrder: string[] = [];
    const phaseStates: Record<string, 'pending' | 'active' | 'done'> = {};

    for (const entry of active.log) {
      if (entry.kind !== 'event') continue;
      eventCount += 1;
      bytes += entry.data.length;
      if (lastTs != null) gaps.push(entry.timestamp - lastTs);
      lastTs = entry.timestamp;

      const ev = entry.event.toLowerCase();

      // `token` events — append data to assembled output, count tokens.
      if (ev === 'token') {
        tokenCount += 1;
        assembledText += entry.data;
      } else if (ev === 'message') {
        // `message` may carry a JSON payload with a token / text / phase
        // — be lenient: try JSON, else append.
        try {
          const parsed = JSON.parse(entry.data) as Record<string, unknown>;
          if (typeof parsed['token'] === 'string') {
            assembledText += parsed['token'];
            tokenCount += 1;
          } else if (typeof parsed['text'] === 'string') {
            assembledText += parsed['text'];
          } else if (typeof parsed['delta'] === 'string') {
            assembledText += parsed['delta'];
            tokenCount += 1;
          }
          const phase = parsed['phase'];
          if (typeof phase === 'string') {
            if (!(phase in phaseStates)) {
              phaseOrder.push(phase);
            }
            // Mark previous phases done.
            for (const p of phaseOrder) {
              if (p === phase) phaseStates[p] = 'active';
              else if (phaseStates[p] !== 'done') phaseStates[p] = 'done';
            }
          }
        } catch {
          // Not JSON — show raw line in the timeline only.
        }
      } else if (ev === 'progress') {
        // Accept `{"progress":0.42}` or a bare number.
        try {
          const parsed: unknown = JSON.parse(entry.data);
          if (typeof parsed === 'number') {
            progress = parsed > 1 ? parsed / 100 : parsed;
          } else if (parsed && typeof parsed === 'object') {
            const obj = parsed as Record<string, unknown>;
            const v = obj['progress'] ?? obj['value'];
            if (typeof v === 'number') progress = v > 1 ? v / 100 : v;
          }
        } catch {
          const n = Number(entry.data);
          if (Number.isFinite(n)) progress = n > 1 ? n / 100 : n;
        }
      } else if (ev === 'done') {
        progress = 1;
        // Mark all phases done.
        for (const p of phaseOrder) phaseStates[p] = 'done';
      }
    }

    const avgGapMs = gaps.length === 0 ? null : gaps.reduce((a, b) => a + b, 0) / gaps.length;

    const phases: SsePhase[] = phaseOrder.map((id) => ({
      id,
      label: id,
      state: phaseStates[id] ?? 'pending',
    }));

    return {
      eventCount,
      bytes,
      tokenCount,
      avgGapMs,
      assembledText,
      progress,
      phases,
    };
  }, [active]);

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
        onStop={handleDisconnect}
        canStop={isStreaming}
      />

      <div className="flex-1 min-h-0 grid gap-2.5 p-3" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
        <SseEventTimeline
          log={filtered}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          eventNameFilter={active.eventNameFilter}
          onEventNameFilterChange={(v) => setEventNameFilter(active.id, v)}
          eventNames={eventNames}
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
