import { grpcStatusToHttpStatus } from '@shared/protocol/grpc-status';
import { Check, Copy, Download } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { toast } from 'sonner';
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

// Mirrors ResponseViewer's PRETTY_PRINT_MAX_BYTES — parsing + re-stringifying
// a huge body/frame on every render can freeze the UI; skip it and show raw
// text past this size instead.
const PRETTY_PRINT_MAX_BYTES = 1_000_000;

// A long-running server-streaming call can accumulate thousands of frames;
// rendering every one as its own <pre> block would make the DOM (and typing
// in the rest of the app) sluggish. Cap what's rendered — Copy/Download still
// include everything via `copyableText`.
const MAX_RENDERED_FRAMES = 500;

function prettyJson(raw: string): string {
  if (!raw) return '';
  if (raw.length > PRETTY_PRINT_MAX_BYTES) return raw;
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

  const [copied, setCopied] = useState(false);
  const body = useMemo(() => prettyJson(response?.body ?? ''), [response?.body]);
  const copyableText = useMemo(() => {
    if (!response) return '';
    if (response.messages && response.messages.length > 0) {
      return response.messages.map((m) => prettyJson(m)).join('\n\n');
    }
    return body;
  }, [response, body]);
  const trailers = response?.trailers ?? {};
  const grpcStatus: GrpcStatusCode | undefined = response?.grpcStatus;
  const grpcStatusName =
    grpcStatus != null ? `${grpcStatus} (${GrpcStatusCodeName[grpcStatus] ?? '?'})` : '—';
  const isOk = grpcStatus === 0;
  // StatusPill maps numeric ranges; map the gRPC code onto its HTTP-status
  // equivalent (OK→200, NOT_FOUND→404, …) so the pill colors match the HTTP
  // convention used elsewhere.
  const pillStatus = grpcStatus == null ? 0 : grpcStatusToHttpStatus(grpcStatus);
  const pillText =
    grpcStatus == null ? 'idle' : isOk ? 'OK' : (GrpcStatusCodeName[grpcStatus] ?? 'ERR');

  const frameCount = response?.messages?.length ?? (response?.body ? 1 : 0);
  // Try to read a content-encoding/grpc-encoding trailer for compression.
  const compression = trailers['grpc-encoding'] ?? trailers['content-encoding'] ?? 'identity';

  const handleCopyBody = async () => {
    try {
      await navigator.clipboard.writeText(copyableText);
      setCopied(true);
      toast.success('Response body copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy response body');
    }
  };

  const handleDownloadBody = () => {
    if (!response) return;
    const blob = new Blob([copyableText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${response.requestId || 'grpc-response'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

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
        {response && (
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={handleCopyBody}
              disabled={!copyableText}
              aria-label={copied ? 'Response body copied' : 'Copy response body'}
              title={copied ? 'Copied!' : 'Copy response body'}
              className="inline-flex items-center justify-center h-7 w-7 rounded-sp-btn text-sp-dim hover:text-sp-text hover:bg-sp-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={handleDownloadBody}
              disabled={!copyableText}
              aria-label="Download response"
              title="Download response"
              className="inline-flex items-center justify-center h-7 w-7 rounded-sp-btn text-sp-dim hover:text-sp-text hover:bg-sp-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
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
            {response.messages.slice(0, MAX_RENDERED_FRAMES).map((m, i) => (
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
            {response.messages.length > MAX_RENDERED_FRAMES && (
              <div className="text-sp-11 text-sp-muted font-mono pt-1">
                {response.messages.length - MAX_RENDERED_FRAMES} more frame
                {response.messages.length - MAX_RENDERED_FRAMES > 1 ? 's' : ''} received but not
                rendered — still included in Copy/Download.
              </div>
            )}
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
        <div className="max-h-40 overflow-y-auto">
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
              {response?.grpcStatusText && response.grpcStatusText.length > 0
                ? response.grpcStatusText
                : '—'}
            </span>
            {/* Every remaining trailer is rendered — nothing is silently
                dropped. The section scrolls internally past a handful of
                entries instead of truncating the list. */}
            {Object.entries(trailers)
              .filter(([k]) => k !== 'grpc-status' && k !== 'grpc-message')
              .map(([k, v]) => (
                <Fragment key={k}>
                  <span className="text-sp-muted">{k}</span>
                  <span className="text-sp-text truncate" title={v}>
                    {v}
                  </span>
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
