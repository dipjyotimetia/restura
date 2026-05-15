import { Input } from '@/components/ui/input';
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
 * toggle. Pure leaf — owns no state.
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
        <p className="text-xs font-mono text-muted-foreground uppercase tracking-widest">
          Retry Policy
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground font-mono mb-1 block">
              Max Attempts
            </label>
            <Input
              type="number"
              min={1}
              max={10}
              value={retryMaxAttempts}
              onChange={(e) =>
                onRetryMaxAttemptsChange(
                  Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1))
                )
              }
              className="h-7 text-xs font-mono"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground font-mono mb-1 block">
              Retry Delay (ms)
            </label>
            <Input
              type="number"
              min={0}
              step={500}
              value={retryDelayMs}
              onChange={(e) =>
                onRetryDelayMsChange(Math.max(0, parseInt(e.target.value, 10) || 0))
              }
              className="h-7 text-xs font-mono"
            />
          </div>
        </div>
        {retryMaxAttempts > 1 && (
          <p className="text-[11px] text-muted-foreground font-mono">
            Will retry up to {retryMaxAttempts - 1} time
            {retryMaxAttempts > 2 ? 's' : ''} on failure, waiting {retryDelayMs}ms
            between attempts.
          </p>
        )}
      </div>
      <div className="space-y-3">
        <p className="text-xs font-mono text-muted-foreground uppercase tracking-widest">
          Compression
        </p>
        <div className="flex items-center gap-3">
          <input
            id="use-compression"
            type="checkbox"
            checked={useCompression}
            onChange={(e) => onUseCompressionChange(e.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          <label
            htmlFor="use-compression"
            className="text-xs font-mono cursor-pointer"
          >
            Send gzip-compressed requests
          </label>
        </div>
        {useCompression && !isElectron() && (
          <p className="text-[11px] text-amber-400 font-mono">
            Compression is only supported in the Electron desktop app.
          </p>
        )}
      </div>
    </div>
  );
}

export default GrpcSettingsPanel;
