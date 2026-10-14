import { Checkbox } from '@/components/ui/checkbox';
import { TextField } from '@/components/ui/spatial';
import {
  DEFAULT_GRPC_DEADLINE_MS,
  grpcDeadlineMs,
  hasNoDeadline,
  NO_GRPC_DEADLINE,
} from '@/features/grpc/lib/grpcDeadline';
import type { GrpcRequest } from '@/types';

interface GrpcDeadlineFieldProps {
  request: Pick<GrpcRequest, 'methodType' | 'timeout'>;
  onChange: (timeout: number) => void;
}

/**
 * Per-call deadline control. Streaming methods get a "No deadline" opt-out
 * (stored as `timeout: 0`) so watch/subscribe streams can stay open; unary
 * calls always keep a deadline.
 */
export function GrpcDeadlineField({ request, onChange }: GrpcDeadlineFieldProps) {
  const streaming = request.methodType !== 'unary';
  const noDeadline = hasNoDeadline(request);
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className="sp-label">Timeout (ms)</span>
      <TextField
        mono
        size="sm"
        type="number"
        value={noDeadline ? '' : grpcDeadlineMs(request)}
        placeholder={noDeadline ? 'None' : undefined}
        disabled={noDeadline}
        onChange={(e) =>
          onChange(Math.max(1000, parseInt(e.target.value, 10) || DEFAULT_GRPC_DEADLINE_MS))
        }
        min={1000}
        step={1000}
        aria-label="gRPC request timeout in milliseconds"
        className="w-24"
      />
      {streaming && (
        <label
          htmlFor="grpc-no-deadline"
          className="flex items-center gap-1.5 text-sp-12 text-sp-text whitespace-nowrap"
        >
          <Checkbox
            id="grpc-no-deadline"
            checked={noDeadline}
            onCheckedChange={(value) =>
              onChange(value === true ? NO_GRPC_DEADLINE : DEFAULT_GRPC_DEADLINE_MS)
            }
          />
          No deadline
        </label>
      )}
    </div>
  );
}
