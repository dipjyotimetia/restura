import { AlertCircle, Laptop, Link2, Loader2, Play, X } from 'lucide-react';
import GrpcStreamingControls from './GrpcStreamingControls';
import { VariableInput } from '@/components/shared/VariableInput';
import { Button } from '@/components/ui/button';
import { Floater, Kbd, Segmented, VariableText, hasVariableToken } from '@/components/ui/spatial';
import { useVariableStatus } from '@/hooks/useVariableStatus';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';
import { isElectron } from '@/lib/shared/platform';
import { cn } from '@/lib/shared/utils';
import type { GrpcMethodType } from '@/types';

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

// Client- and bidirectional-streaming need a duplex connection the browser
// can't provide, so they only work in the desktop app. Server-streaming and
// unary both work on web (via the Web Stream tab and the proxy respectively).
// Surface a "desktop only" icon directly on the primary selector — this is
// the first control a user sees, so it's the place that needs to warn them,
// not just the (secondary, reflection-only) method dropdown.
const DESKTOP_ONLY_METHOD_TYPES: ReadonlySet<GrpcMethodType> = new Set([
  'client-streaming',
  'bidirectional-streaming',
]);

function buildMethodTypeOptions(desktopOnlyBadge: boolean) {
  const base: ReadonlyArray<{ value: GrpcMethodType; label: string }> = [
    { value: 'unary', label: 'Unary' },
    { value: 'server-streaming', label: 'Server' },
    { value: 'client-streaming', label: 'Client' },
    { value: 'bidirectional-streaming', label: 'Bidi' },
  ];
  if (!desktopOnlyBadge) return base;
  return base.map((opt) =>
    DESKTOP_ONLY_METHOD_TYPES.has(opt.value)
      ? {
          ...opt,
          icon: <Laptop className="size-2.5" aria-label="Desktop app required" />,
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
  const getVarStatus = useVariableStatus();
  const methodTypeOptions = buildMethodTypeOptions(!isElectron());
  const showVariableOverlay = hasVariableToken(url) && isUrlValid;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Floater
          radius="btn"
          className="flex-1 min-w-0 flex items-center gap-2 pl-1.5 pr-1.5 h-10 focus-within:ring-1 focus-within:ring-sp-accent/40"
          style={{ background: 'var(--sp-surface)' }}
        >
          <Segmented<GrpcMethodType>
            options={methodTypeOptions}
            value={methodType}
            onChange={onMethodTypeChange}
            size="sm"
            ariaLabel="gRPC method type"
          />
          <span className="text-sp-dim font-mono text-sp-12 select-none shrink-0">›</span>
          <div className="relative flex-1 min-w-0 h-7 flex items-center">
            <VariableInput
              rawInput
              type="text"
              value={url}
              onValueChange={onUrlChange}
              placeholder={ECHO_URLS.grpc}
              aria-label="gRPC server URL"
              spellCheck={false}
              className={cn(
                'w-full bg-transparent border-0 outline-none px-1',
                'font-mono text-sp-13 text-sp-text placeholder:text-sp-dim',
                !isUrlValid && 'text-red-400',
                showVariableOverlay && 'text-transparent caret-sp-accent'
              )}
            />
            {showVariableOverlay && (
              <div
                aria-hidden="true"
                className="absolute inset-0 pointer-events-none flex items-center overflow-hidden px-1"
              >
                <VariableText
                  text={url}
                  getStatus={getVarStatus}
                  className="font-mono text-sp-13 text-sp-text whitespace-pre"
                />
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              if (!url) return;
              void navigator.clipboard?.writeText(url);
            }}
            disabled={!url}
            aria-label="Copy gRPC server URL"
            className={cn(
              'inline-flex items-center justify-center h-6 w-6 rounded-sp-btn text-sp-dim shrink-0',
              'hover:text-sp-text hover:bg-sp-hover transition-colors',
              'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent'
            )}
          >
            <Link2 className="h-3.5 w-3.5" />
          </button>
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
          {!isLoading && (
            <Kbd size="xs" className="ml-0.5 border-white/30 bg-white/15 text-white">
              ⌘↵
            </Kbd>
          )}
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
