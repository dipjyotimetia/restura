import { TextField, ToggleField } from '@/components/ui/spatial';
import { isElectron } from '@/lib/shared/platform';

interface GrpcSettingsPanelProps {
  timeoutMs: number;
  retryMaxAttempts: number;
  retryDelayMs: number;
  useCompression: boolean;
  onTimeoutMsChange: (value: number) => void;
  onRetryMaxAttemptsChange: (value: number) => void;
  onRetryDelayMsChange: (value: number) => void;
  onUseCompressionChange: (value: boolean) => void;
}

/**
 * Settings tab body for the gRPC builder: timeout, retry policy, and gzip
 * compression toggle. Pure leaf — owns no state. Uses Spatial Depth atoms
 * for inputs and the toggle row.
 */
export function GrpcSettingsPanel({
  timeoutMs,
  retryMaxAttempts,
  retryDelayMs,
  useCompression,
  onTimeoutMsChange,
  onRetryMaxAttemptsChange,
  onRetryDelayMsChange,
  onUseCompressionChange,
}: GrpcSettingsPanelProps) {
  return (
    <div className="space-y-6 max-w-sm">
      <div className="space-y-3">
        <p className="sp-label">Timeout</p>
        <div className="flex flex-col gap-1.5 w-40">
          <label htmlFor="grpc-timeout-ms" className="text-sp-11 text-sp-muted font-mono">
            Timeout (ms)
          </label>
          <TextField
            id="grpc-timeout-ms"
            mono
            size="sm"
            type="number"
            min={1000}
            step={1000}
            value={timeoutMs}
            onChange={(e) =>
              onTimeoutMsChange(Math.max(1000, parseInt(e.target.value, 10) || 30000))
            }
            aria-label="gRPC request timeout in milliseconds"
          />
        </div>
      </div>
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
      {!isElectron() && (
        <div className="space-y-3">
          <p className="sp-label">TLS</p>
          <p className="text-sp-11 text-sp-muted font-mono">
            Custom CA, client certificates, and the verify-SSL toggle configured in Settings →
            Certificates apply to HTTP requests only. The browser build has no per-request TLS
            control for gRPC — an mTLS-only or private-CA server will fail here even if it works for
            HTTP. Use the desktop app for gRPC calls that need custom TLS material.
          </p>
        </div>
      )}
    </div>
  );
}

export default GrpcSettingsPanel;
