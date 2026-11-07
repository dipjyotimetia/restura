import type { DescMessage } from '@bufbuild/protobuf';
import { AlertCircle, Laptop, Loader2, Play } from 'lucide-react';
import { toast } from 'sonner';
import { VariableUrlInput } from '@/components/shared/VariableUrlInput';
import { Button } from '@/components/ui/button';
import { Floater, Segmented } from '@/components/ui/spatial';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';
import { isElectron } from '@/lib/shared/platform';
import type { GrpcMethodType } from '@/types';
import GrpcStreamingControls from './GrpcStreamingControls';

interface StreamControl {
  sendMessage: (msg: unknown) => void;
  endStream: () => void;
  cancelStream: () => void;
  /** Input schema for 64-bit-precise parsing of typed messages (parseGrpcMessageJson). */
  inputSchema?: () => DescMessage | undefined;
}

export interface GrpcInvocationBarProps {
  methodType: GrpcMethodType;
  url: string;
  isLoading: boolean;
  isFormValid: boolean;
  streamControl: StreamControl | null;
  urlError?: string | undefined;
  isUrlValid: boolean;
  onMethodTypeChange: (methodType: GrpcMethodType) => void;
  onUrlChange: (url: string) => void;
  onSend: () => void;
  onCancelStream: () => void;
}

const METHOD_TYPE_OPTIONS = [
  { value: 'unary', label: 'Unary' },
  { value: 'server-streaming', label: 'Server' },
  { value: 'client-streaming', label: 'Client' },
  { value: 'bidirectional-streaming', label: 'Bidi' },
] as const satisfies ReadonlyArray<{ value: GrpcMethodType; label: string }>;

/**
 * Client-streaming and bidi need a duplex channel only the desktop transport
 * has (see capabilities/grpc.ts) — on web they'd fail at send time.
 */
export const GRPC_DESKTOP_ONLY_TYPES: ReadonlySet<GrpcMethodType> = new Set([
  'client-streaming',
  'bidirectional-streaming',
]);
export const GRPC_DESKTOP_ONLY_HINT =
  'Client-streaming and bidirectional calls need the Restura desktop app — the web transport supports unary and server-streaming only.';

function methodTypeOptions(web: boolean) {
  if (!web) return METHOD_TYPE_OPTIONS;
  return METHOD_TYPE_OPTIONS.map((opt) =>
    GRPC_DESKTOP_ONLY_TYPES.has(opt.value)
      ? {
          value: opt.value,
          disabled: true,
          title: `Desktop only — ${GRPC_DESKTOP_ONLY_HINT}`,
          label: (
            <span className="inline-flex items-center gap-1">
              {opt.label}
              <Laptop className="size-2.5" aria-label="Desktop only" />
            </span>
          ),
        }
      : opt
  );
}

/**
 * Spatial Depth method invocation bar — Segmented method-type picker +
 * monospace URL input + Invoke button, wrapped in a single Floater pill.
 * Renders streaming controls below when a stream is active and an
 * inline validation error when the URL is invalid.
 */
export function GrpcInvocationBar({
  methodType,
  url,
  isLoading,
  isFormValid,
  streamControl,
  urlError,
  isUrlValid,
  onMethodTypeChange,
  onUrlChange,
  onSend,
  onCancelStream,
}: GrpcInvocationBarProps) {
  const web = !isElectron();
  const handleMethodTypeChange = (next: GrpcMethodType) => {
    if (web && GRPC_DESKTOP_ONLY_TYPES.has(next)) {
      toast.info('Desktop only', { description: GRPC_DESKTOP_ONLY_HINT });
      return;
    }
    onMethodTypeChange(next);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Floater
          radius="btn"
          className="flex-1 min-w-0 flex items-center gap-2 pl-1.5 pr-1.5 h-10 focus-within:ring-1 focus-within:ring-sp-accent/40"
          style={{ background: 'var(--sp-surface)' }}
        >
          <Segmented<GrpcMethodType>
            options={methodTypeOptions(web)}
            value={methodType}
            onChange={handleMethodTypeChange}
            size="sm"
            ariaLabel="gRPC method type"
          />
          <span className="text-sp-dim font-mono text-sp-12 select-none shrink-0">›</span>
          <VariableUrlInput
            value={url}
            onValueChange={onUrlChange}
            variableScope="request"
            placeholder={ECHO_URLS.grpc}
            aria-label="gRPC server URL"
            invalid={!isUrlValid}
            className="flex-1 h-7"
            textClassName="px-1 text-sp-13"
          />
        </Floater>

        <Button
          type="button"
          variant="cta"
          size="cta"
          onClick={onSend}
          disabled={(isLoading && !streamControl) || !isFormValid}
          aria-label={isLoading ? 'Invoking gRPC method' : 'Invoke gRPC method'}
          className="shrink-0"
        >
          {isLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" fill="currentColor" />
          )}
          {isLoading ? 'Invoking…' : 'Invoke'}
        </Button>
      </div>

      {streamControl && (
        <Floater
          radius="btn"
          className="flex items-center gap-2 px-3 py-1.5"
          style={{ background: 'var(--sp-surface-lo)' }}
        >
          <span className="sp-label">Stream</span>
          <GrpcStreamingControls
            streamControl={streamControl}
            methodType={methodType}
            onCancel={onCancelStream}
          />
        </Floater>
      )}

      {web && GRPC_DESKTOP_ONLY_TYPES.has(methodType) && (
        <div
          role="note"
          className="flex items-center gap-1.5 text-sp-11 font-mono text-amber-700 dark:text-amber-400"
        >
          <Laptop className="h-3 w-3 shrink-0" />
          {GRPC_DESKTOP_ONLY_HINT}
        </div>
      )}

      {!isUrlValid && urlError && (
        <div
          className="flex items-center gap-1.5 text-sp-11 font-mono"
          role="alert"
          style={{ color: 'var(--color-danger)' }}
        >
          <AlertCircle className="h-3 w-3" />
          {urlError}
        </div>
      )}
    </div>
  );
}

export default GrpcInvocationBar;
