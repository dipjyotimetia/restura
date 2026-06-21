import { AlertCircle, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import GrpcStreamingControls from './GrpcStreamingControls';
import type { GrpcMethodType } from '@/types';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';
import { cn } from '@/lib/shared/utils';

const METHOD_TYPE_COLOR: Record<GrpcMethodType, string> = {
  unary: 'bg-emerald-500/[0.12] border-emerald-500/25 text-emerald-400',
  'server-streaming': 'bg-blue-500/[0.12] border-blue-500/25 text-blue-400',
  'client-streaming': 'bg-amber-500/[0.12] border-amber-500/25 text-amber-400',
  'bidirectional-streaming': 'bg-violet-500/[0.12] border-violet-500/25 text-violet-400',
};

interface StreamControl {
  sendMessage: (msg: unknown) => void;
  endStream: () => void;
  cancelStream: () => void;
}

interface GrpcUrlBarProps {
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
  /** Cancel an in-flight stream and clear loading state */
  onCancelStream: () => void;
}

/**
 * Top URL bar for the gRPC builder: method-type picker, URL input,
 * Send/Invoke button, optional streaming controls row, URL validation
 * banner. All state lives in the parent — this is pure JSX glue.
 */
export function GrpcUrlBar({
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
}: GrpcUrlBarProps) {
  return (
    <>
      <div className="flex items-center gap-1 px-3 h-12 border-y glass-border-subtle glass-3 shrink-0">
        <Select
          value={methodType}
          onValueChange={(value) => onMethodTypeChange(value as GrpcMethodType)}
        >
          <SelectTrigger
            className={cn(
              'w-44 h-7 font-mono text-[11px] font-bold border shrink-0',
              METHOD_TYPE_COLOR[methodType]
            )}
            aria-label="gRPC method type"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-popover border-border">
            <SelectItem value="unary" className="font-mono text-xs">
              <span className="text-emerald-400">Unary</span>
            </SelectItem>
            <SelectItem value="server-streaming" className="font-mono text-xs">
              <span className="text-blue-400">Server Streaming</span>
            </SelectItem>
            <SelectItem value="client-streaming" className="font-mono text-xs">
              <span className="text-amber-400">Client Streaming</span>
            </SelectItem>
            <SelectItem value="bidirectional-streaming" className="font-mono text-xs">
              <span className="text-violet-400">Bidirectional</span>
            </SelectItem>
          </SelectContent>
        </Select>
        <span className="text-muted-foreground/40 font-mono text-sm select-none shrink-0">›</span>
        <Input
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder={ECHO_URLS.grpc}
          className="flex-1 h-7 bg-transparent border-0 font-mono text-sm px-2 focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none placeholder:text-muted-foreground/40"
          aria-label="gRPC server URL"
        />
        <Button
          variant="glow"
          size="sm"
          onClick={onSend}
          disabled={(isLoading && !streamControl) || !isFormValid}
          aria-label={isLoading ? 'Invoking gRPC method' : 'Invoke gRPC method'}
          className="h-7 min-w-[72px] text-xs font-medium shrink-0"
        >
          <Send className="mr-1.5 h-3.5 w-3.5" />
          {isLoading ? 'Invoking...' : 'Invoke'}
        </Button>
      </div>

      {streamControl && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b glass-border-subtle glass-2">
          <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest shrink-0">
            Stream
          </span>
          <GrpcStreamingControls
            streamControl={streamControl}
            methodType={methodType}
            onCancel={onCancelStream}
          />
        </div>
      )}

      {!isUrlValid && urlError && (
        <div className="text-xs text-destructive mx-3 mt-1 flex items-center gap-1" role="alert">
          <AlertCircle className="h-3 w-3" />
          {urlError}
        </div>
      )}
    </>
  );
}

export default GrpcUrlBar;
