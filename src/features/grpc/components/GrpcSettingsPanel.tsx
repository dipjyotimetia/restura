import { TextField, ToggleField } from '@/components/ui/spatial';
import { isElectron } from '@/lib/shared/platform';

interface GrpcSettingsPanelProps {
  retryMaxAttempts: number;
  retryDelayMs: number;
  useCompression: boolean;
  onRetryMaxAttemptsChange: (value: number) => void;
  onRetryDelayMsChange: (value: number) => void;
  onUseCompressionChange: (value: boolean) => void;
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
}: GrpcSettingsPanelProps) {
  return (
    <div className="space-y-6 max-w-sm">
      <div className="space-y-3">
        <p className="sp-label">Retry Policy</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-sp-11 text-sp-muted font-mono">Max Attempts</label>
            <TextField
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
            <label className="text-sp-11 text-sp-muted font-mono">Retry Delay (ms)</label>
            <TextField
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
          <p className="text-sp-11 font-mono" style={{ color: '#f59e0b' }}>
            Compression is only supported in the Electron desktop app.
          </p>
        )}
      </div>
    </div>
  );
}

export default GrpcSettingsPanel;
