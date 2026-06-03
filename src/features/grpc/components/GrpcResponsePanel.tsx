import { Fragment, useMemo } from 'react';
import { Floater, Stat, StatusPill } from '@/components/ui/spatial';
import { useActiveResponse } from '@/store/selectors';
import { useRequestStore } from '@/store/useRequestStore';
import { GrpcStatusCodeName, type GrpcResponse, type GrpcStatusCode } from '@/types';

function formatBytes(n: number | undefined): string {
  if (!n || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function prettyJson(raw: string): string {
  if (!raw) return '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * Spatial Depth response panel for gRPC. Shows status + time header,
 * formatted JSON body (or streamed messages), a trailers grid, and a
 * footer with size / frames / compression stats.
 */
export function GrpcResponsePanel() {
  // Self-sufficient peer of ResponseViewer: read the active response from the
  // store and narrow it to the gRPC shape here, so the route stays protocol-
  // agnostic. The slot type is the generic ApiResponse union.
  const activeResponse = useActiveResponse();
  const isLoading = useRequestStore((s) => s.isLoading);
  const response =
    activeResponse && 'grpcStatus' in activeResponse ? (activeResponse as GrpcResponse) : null;

  const body = useMemo(() => prettyJson(response?.body ?? ''), [response?.body]);
  const trailers = response?.trailers ?? {};
  const grpcStatus: GrpcStatusCode | undefined = response?.grpcStatus;
  const grpcStatusName =
    grpcStatus != null ? `${grpcStatus} (${GrpcStatusCodeName[grpcStatus] ?? '?'})` : '—';
  const isOk = grpcStatus === 0;
  // StatusPill maps numeric ranges; map gRPC OK → 200, error codes → 500
  // range so the pill colors match the HTTP convention used elsewhere.
  const pillStatus = grpcStatus == null ? 0 : grpcStatus === 0 ? 200 : 500;
  const pillText =
    grpcStatus == null ? 'idle' : isOk ? 'OK' : (GrpcStatusCodeName[grpcStatus] ?? 'ERR');

  const frameCount = response?.messages?.length ?? (response?.body ? 1 : 0);
  // Try to read a content-encoding/grpc-encoding trailer for compression.
  const compression = trailers['grpc-encoding'] ?? trailers['content-encoding'] ?? 'identity';

  return (
    <Floater
      radius="panel"
      elevation="float-lg"
      className="flex flex-col overflow-hidden h-full"
      style={{ background: 'var(--sp-code)' }}
    >
      {/* Header: status + time */}
      <div
        className="flex items-center gap-3 px-3.5 py-2.5 border-b border-sp-line"
        style={{ background: 'var(--sp-surface)' }}
      >
        <span className="text-sp-12 font-semibold text-sp-text">Response</span>
        <StatusPill status={pillStatus} text={`· ${pillText}`} />
        <div className="flex-1" />
        <Stat label="Time" value={`${response?.time ?? 0} ms`} />
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto">
        {isLoading && !response ? (
          <div className="flex items-center justify-center h-full text-sp-muted text-sp-12 font-mono">
            Waiting for response…
          </div>
        ) : !response ? (
          <div className="flex items-center justify-center h-full text-sp-dim text-sp-12 font-mono">
            No response yet. Invoke a method to see the result here.
          </div>
        ) : response.messages && response.messages.length > 0 ? (
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
        )}
      </div>

      {/* Trailers */}
      <div className="px-3.5 py-3 border-t border-sp-line">
        <div className="sp-label mb-2">Trailers</div>
        <div
          className="grid font-mono text-sp-11-5"
          style={{
            gridTemplateColumns: 'auto 1fr',
            columnGap: 14,
            rowGap: 4,
          }}
        >
          <span className="text-sp-muted">grpc-status</span>
          <span
            style={{ color: isOk ? '#22c55e' : grpcStatus != null ? '#ef4444' : 'var(--sp-text)' }}
          >
            {grpcStatusName}
          </span>
          <span className="text-sp-muted">grpc-message</span>
          <span className="text-sp-text truncate">
            {response?.grpcStatusText && response.grpcStatusText.length > 0
              ? response.grpcStatusText
              : '—'}
          </span>
          {Object.entries(trailers)
            .filter(([k]) => k !== 'grpc-status' && k !== 'grpc-message')
            .slice(0, 6)
            .map(([k, v]) => (
              <Fragment key={k}>
                <span className="text-sp-muted">{k}</span>
                <span className="text-sp-text truncate">{v}</span>
              </Fragment>
            ))}
          {Object.keys(trailers).length === 0 && (
            <Fragment>
              <span className="text-sp-muted">content-type</span>
              <span className="text-sp-text">application/grpc</span>
            </Fragment>
          )}
        </div>
      </div>

      {/* Footer stats */}
      <div className="flex items-center gap-6 px-3.5 py-3 border-t border-sp-line">
        <Stat label="Size" value={formatBytes(response?.size)} />
        <Stat label="Frames" value={String(frameCount)} />
        <Stat label="Compr" value={compression} />
      </div>
    </Floater>
  );
}

export default GrpcResponsePanel;
