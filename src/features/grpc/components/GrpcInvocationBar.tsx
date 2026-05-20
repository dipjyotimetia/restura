import { AlertCircle, Loader2, Play, X } from 'lucide-react';
import { Floater, Segmented } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';
import GrpcStreamingControls from './GrpcStreamingControls';
import type { GrpcMethodType } from '@/types';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';

interface StreamControl {
  sendMessage: (msg: unknown) => void;
  endStream: () => void;
  cancelStream: () => void;
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
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-stretch gap-2">
        <Floater
          radius="btn"
          className="flex-1 flex items-center gap-2 pl-1.5 pr-1.5 h-10"
          style={{ background: 'var(--sp-surface)' }}
        >
          <Segmented<GrpcMethodType>
            options={METHOD_TYPE_OPTIONS}
            value={methodType}
            onChange={onMethodTypeChange}
            size="sm"
            ariaLabel="gRPC method type"
          />
          <span className="text-sp-dim font-mono text-sp-12 select-none shrink-0">›</span>
          <input
            type="text"
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder={ECHO_URLS.grpc}
            aria-label="gRPC server URL"
            className={cn(
              'flex-1 h-7 bg-transparent border-0 outline-none px-1',
              'font-mono text-sp-13 text-sp-text placeholder:text-sp-dim',
              !isUrlValid && 'text-red-400'
            )}
          />
        </Floater>

        <button
          type="button"
          onClick={onSend}
          disabled={(isLoading && !streamControl) || !isFormValid}
          aria-label={isLoading ? 'Invoking gRPC method' : 'Invoke gRPC method'}
          className={cn(
            'inline-flex items-center justify-center gap-1.5 h-10 px-5 rounded-sp-btn shrink-0',
            'font-semibold text-sp-13 transition-all',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            'text-white'
          )}
          style={{
            background: 'linear-gradient(180deg, var(--sp-accent), #3a85ee)',
            boxShadow:
              '0 8px 24px var(--sp-accent-glow-33), inset 0 1px 0 rgba(255,255,255,0.3), 0 0 0 1px var(--sp-accent-glow-55)',
          }}
        >
          {isLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" fill="currentColor" />
          )}
          {isLoading ? 'Invoking…' : 'Invoke'}
        </button>
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
          <button
            type="button"
            onClick={onCancelStream}
            className="ml-auto inline-flex items-center gap-1 h-6 px-2 rounded-sp-chip text-sp-11 text-sp-muted hover:text-sp-text hover:bg-sp-hover"
          >
            <X className="h-3 w-3" /> Cancel
          </button>
        </Floater>
      )}

      {!isUrlValid && urlError && (
        <div
          className="flex items-center gap-1.5 text-sp-11 font-mono"
          role="alert"
          style={{ color: '#ef4444' }}
        >
          <AlertCircle className="h-3 w-3" />
          {urlError}
        </div>
      )}
    </div>
  );
}

export default GrpcInvocationBar;
