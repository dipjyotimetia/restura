import { grpcStatusToHttpStatus } from '@shared/protocol/grpc-status';
import { Radio } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { ResponseEmptyState } from '@/components/shared/ResponseEmptyState';
import type { SubTab } from '@/components/ui/spatial';
import { Floater, Stat, StatusPill, SubTabBar, SubTabPanel } from '@/components/ui/spatial';
import { formatBytes, formatTime } from '@/lib/shared/utils';
import { useActiveResponse } from '@/store/selectors';
import { useRequestStore } from '@/store/useRequestStore';
import { type GrpcResponse, type GrpcStatusCode, GrpcStatusCodeName } from '@/types';

function prettyJson(raw: string): string {
  if (!raw) return '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

type GrpcResponseTab = 'body' | 'trailers';

/**
 * Spatial Depth response panel for gRPC. Mirrors the HTTP ResponseViewer's
 * anatomy — status row (pill + time/size stats), SubTabBar (Body | Trailers),
 * tab panels — so switching protocols doesn't reshuffle the response side.
 */
export function GrpcResponsePanel() {
  // Self-sufficient peer of ResponseViewer: read the active response from the
  // store and narrow it to the gRPC shape here, so the route stays protocol-
  // agnostic. The slot type is the generic ApiResponse union.
  const activeResponse = useActiveResponse();
  const isLoading = useRequestStore((s) => s.isLoading);
  const [activeTab, setActiveTab] = useState<GrpcResponseTab>('body');
  const response =
    activeResponse && 'grpcStatus' in activeResponse ? (activeResponse as GrpcResponse) : null;

  const body = useMemo(() => prettyJson(response?.body ?? ''), [response?.body]);

  if (isLoading && !response) {
    return (
      <Floater
        radius="panel"
        elevation="float-lg"
        className="h-full flex items-center justify-center relative z-20"
      >
        <p className="text-sp-12 text-sp-muted font-mono animate-pulse">Waiting for response…</p>
      </Floater>
    );
  }

  if (!response) {
    return (
      <ResponseEmptyState
        icon={<Radio className="h-4 w-4 text-sp-muted" />}
        message="Invoke a method to see the response"
      />
    );
  }

  const trailers = response.trailers ?? {};
  // `grpcStatus` is optional on GrpcResponse itself, so the null checks stay.
  const grpcStatus: GrpcStatusCode | undefined = response.grpcStatus;
  const grpcStatusName =
    grpcStatus != null ? `${grpcStatus} (${GrpcStatusCodeName[grpcStatus] ?? '?'})` : '—';
  const isOk = grpcStatus === 0;
  // StatusPill maps numeric ranges; map the gRPC code onto its HTTP-status
  // equivalent (OK→200, NOT_FOUND→404, …) so the pill colors match the HTTP
  // convention used elsewhere.
  const pillStatus = grpcStatus == null ? 0 : grpcStatusToHttpStatus(grpcStatus);
  const pillText =
    grpcStatus == null ? '—' : isOk ? 'OK' : (GrpcStatusCodeName[grpcStatus] ?? 'ERR');

  const frameCount = response.messages?.length ?? (response.body ? 1 : 0);
  // Try to read a content-encoding/grpc-encoding trailer for compression.
  const compression = trailers['grpc-encoding'] ?? trailers['content-encoding'] ?? 'identity';
  const extraTrailers = Object.entries(trailers).filter(
    ([k]) => k !== 'grpc-status' && k !== 'grpc-message'
  );

  const tabs: ReadonlyArray<SubTab<GrpcResponseTab>> = [
    { value: 'body', label: 'Body', badge: 'JSON' },
    // grpc-status + grpc-message rows always render, hence the +2.
    { value: 'trailers', label: 'Trailers', count: extraTrailers.length + 2 },
  ];

  return (
    <Floater
      radius="panel"
      elevation="float-lg"
      className="flex flex-col overflow-hidden h-full relative z-20"
    >
      {/* Status row — same anatomy as the HTTP viewer's. */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-sp-line">
        <StatusPill status={pillStatus} text={pillText} />
        <Stat label="Time" value={formatTime(response.time)} />
        <Stat label="Size" value={formatBytes(response.size)} />
        <Stat label="Frames" value={String(frameCount)} />
        <Stat label="Compr" value={compression} />
      </div>

      <SubTabBar tabs={tabs} value={activeTab} onChange={setActiveTab} />

      <div className="flex-1 min-h-0 overflow-hidden" style={{ background: 'var(--sp-code)' }}>
        <SubTabPanel tabKey={activeTab} className="h-full overflow-auto">
          {activeTab === 'body' ? (
            response.messages && response.messages.length > 0 ? (
              <div className="px-3.5 py-3 space-y-2">
                {response.messages.map((m, i) => (
                  <div key={i}>
                    <div className="sp-label mb-1">Frame {i + 1}</div>
                    <pre
                      className="m-0 font-mono text-sp-12-5 text-sp-text whitespace-pre-wrap"
                      style={{ lineHeight: 1.55 }}
                    >
                      {prettyJson(m)}
                    </pre>
                  </div>
                ))}
              </div>
            ) : (
              <pre
                className="m-0 px-3.5 py-3 font-mono text-sp-12-5 text-sp-text whitespace-pre-wrap"
                style={{ lineHeight: 1.55 }}
              >
                {body || '(empty body)'}
              </pre>
            )
          ) : (
            <div
              className="grid font-mono text-sp-11-5 px-3.5 py-3"
              style={{
                gridTemplateColumns: 'auto 1fr',
                columnGap: 14,
                rowGap: 4,
              }}
            >
              <span className="text-sp-muted">grpc-status</span>
              <span
                style={{
                  color: isOk
                    ? 'var(--color-success)'
                    : grpcStatus != null
                      ? 'var(--color-danger)'
                      : 'var(--sp-text)',
                }}
              >
                {grpcStatusName}
              </span>
              <span className="text-sp-muted">grpc-message</span>
              <span className="text-sp-text truncate">
                {response.grpcStatusText && response.grpcStatusText.length > 0
                  ? response.grpcStatusText
                  : '—'}
              </span>
              {extraTrailers.slice(0, 6).map(([k, v]) => (
                <Fragment key={k}>
                  <span className="text-sp-muted">{k}</span>
                  <span className="text-sp-text truncate">{v}</span>
                </Fragment>
              ))}
              {extraTrailers.length === 0 && (
                <Fragment>
                  <span className="text-sp-muted">content-type</span>
                  <span className="text-sp-text">application/grpc</span>
                </Fragment>
              )}
            </div>
          )}
        </SubTabPanel>
      </div>
    </Floater>
  );
}

export default GrpcResponsePanel;
