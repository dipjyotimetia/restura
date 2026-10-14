import { Segmented, type SegmentedOption, TextField, ToggleField } from '@/components/ui/spatial';
import { isElectron } from '@/lib/shared/platform';
import type { GrpcWireProtocol } from '@/types';

type WireChoice = GrpcWireProtocol | 'auto';

interface GrpcSettingsPanelProps {
  retryMaxAttempts: number;
  retryDelayMs: number;
  useCompression: boolean;
  onRetryMaxAttemptsChange: (value: number) => void;
  onRetryDelayMsChange: (value: number) => void;
  onUseCompressionChange: (value: boolean) => void;
  /** Persisted per-request wire protocol; undefined = auto. */
  wireProtocol?: GrpcWireProtocol | undefined;
  onWireProtocolChange?: (value: GrpcWireProtocol | undefined) => void;
}

// Native gRPC needs HTTP/2 trailers (desktop only); connect-node has no
// grpc-web-text, so that mode is web/self-host only.
const DESKTOP_WIRE_OPTIONS: ReadonlyArray<SegmentedOption<WireChoice>> = [
  { value: 'auto', label: 'Auto' },
  { value: 'grpc', label: 'gRPC' },
  { value: 'grpc-web', label: 'gRPC-Web' },
  { value: 'connect', label: 'Connect' },
];
const WEB_WIRE_OPTIONS: ReadonlyArray<SegmentedOption<WireChoice>> = [
  { value: 'auto', label: 'Auto' },
  { value: 'grpc-web', label: 'gRPC-Web' },
  { value: 'grpc-web-text', label: 'gRPC-Web text' },
  { value: 'connect', label: 'Connect' },
];

function wireHint(wire: WireChoice, desktop: boolean): string {
  switch (wire) {
    case 'auto':
      return desktop
        ? 'Native gRPC over HTTP/2, falling back to Connect when the server rejects it.'
        : 'Connect JSON through the Restura proxy — no schema needed (unary only).';
    case 'grpc':
      return desktop
        ? 'Native gRPC over HTTP/2 only — no fallback.'
        : 'Native gRPC needs the desktop app. Choose gRPC-Web or Connect here.';
    case 'grpc-web':
      return 'Binary gRPC-Web (application/grpc-web+proto), e.g. an Envoy grpc_web filter. Needs reflection or a .proto.';
    case 'grpc-web-text':
      return desktop
        ? 'gRPC-Web text is available on the web app only.'
        : 'Base64 gRPC-Web (application/grpc-web-text). Needs reflection or a .proto.';
    case 'connect':
      return 'Connect protocol only.';
  }
}

/**
 * Settings tab body for the gRPC builder: retry policy + gzip compression
 * toggle. Pure leaf — owns no state. Uses Spatial Depth atoms for inputs
 * and the toggle row.
 */
export function GrpcSettingsPanel({
  retryMaxAttempts,
  retryDelayMs,
  useCompression,
  onRetryMaxAttemptsChange,
  onRetryDelayMsChange,
  onUseCompressionChange,
  wireProtocol,
  onWireProtocolChange,
}: GrpcSettingsPanelProps) {
  const desktop = isElectron();
  const wire: WireChoice = wireProtocol ?? 'auto';
  return (
    <div className="space-y-6 max-w-sm">
      {onWireProtocolChange && (
        <div className="space-y-3">
          <p className="sp-label">Wire Protocol</p>
          <Segmented<WireChoice>
            size="sm"
            options={desktop ? DESKTOP_WIRE_OPTIONS : WEB_WIRE_OPTIONS}
            value={wire}
            onChange={(v) => onWireProtocolChange(v === 'auto' ? undefined : v)}
            ariaLabel="gRPC wire protocol"
          />
          <p className="text-sp-11 text-sp-muted font-mono">{wireHint(wire, desktop)}</p>
        </div>
      )}
      <div className="space-y-3">
        <p className="sp-label">Retry Policy</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="grpc-retry-max-attempts" className="text-sp-11 text-sp-muted font-mono">
              Max Attempts
            </label>
            <TextField
              id="grpc-retry-max-attempts"
              mono
              size="sm"
              type="number"
              min={1}
              max={10}
              value={retryMaxAttempts}
              onChange={(e) =>
                onRetryMaxAttemptsChange(
                  Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1))
                )
              }
              aria-label="Max retry attempts"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="grpc-retry-delay-ms" className="text-sp-11 text-sp-muted font-mono">
              Retry Delay (ms)
            </label>
            <TextField
              id="grpc-retry-delay-ms"
              mono
              size="sm"
              type="number"
              min={0}
              step={500}
              value={retryDelayMs}
              onChange={(e) => onRetryDelayMsChange(Math.max(0, parseInt(e.target.value, 10) || 0))}
              aria-label="Retry delay in milliseconds"
            />
          </div>
        </div>
        {retryMaxAttempts > 1 && (
          <p className="text-sp-11 text-sp-muted font-mono">
            Will retry up to {retryMaxAttempts - 1} time
            {retryMaxAttempts > 2 ? 's' : ''} on failure, waiting {retryDelayMs}ms between attempts.
          </p>
        )}
      </div>
      <div className="space-y-3">
        <p className="sp-label">Compression</p>
        <div className="flex items-start gap-3">
          <ToggleField
            checked={useCompression}
            onChange={onUseCompressionChange}
            ariaLabel="Send gzip-compressed requests"
          />
          <div className="flex-1">
            <div className="text-sp-12-5 text-sp-text font-medium">
              Send gzip-compressed requests
            </div>
            <div className="text-sp-11 text-sp-muted">
              Wrap outbound frames with gzip to reduce payload size.
            </div>
          </div>
        </div>
        {useCompression && !isElectron() && (
          <p className="text-sp-11 font-mono" style={{ color: 'var(--color-warning)' }}>
            Compression is only supported in the Electron desktop app.
          </p>
        )}
      </div>
    </div>
  );
}

export default GrpcSettingsPanel;
