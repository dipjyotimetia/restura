import { useMemo, useState } from 'react';
import { ChevronRight, Loader2, Upload, Zap } from 'lucide-react';
import { Floater } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';
import { parseProtoFile } from '@/features/grpc/lib/grpcClient';
import { toast } from 'sonner';
import type {
  GrpcMethodType,
  ProtoFileInfo,
  ReflectionMethodInfo,
  ReflectionServiceInfo,
} from '@/types';

type MethodKind = 'U' | 'S' | 'C' | 'B';

const KIND_COLOR: Record<MethodKind, { fg: string; bg: string; title: string }> = {
  U: { fg: '#22c55e', bg: 'rgba(34,197,94,0.16)', title: 'Unary' },
  S: { fg: '#a78bfa', bg: 'rgba(167,139,250,0.16)', title: 'Server streaming' },
  C: { fg: '#06b6d4', bg: 'rgba(6,182,212,0.16)', title: 'Client streaming' },
  B: { fg: '#f59e0b', bg: 'rgba(245,158,11,0.16)', title: 'Bidirectional streaming' },
};

function methodKind(m: ReflectionMethodInfo): MethodKind {
  if (m.clientStreaming && m.serverStreaming) return 'B';
  if (m.serverStreaming) return 'S';
  if (m.clientStreaming) return 'C';
  return 'U';
}

export interface GrpcServiceTreeProps {
  services: ReflectionServiceInfo[];
  selectedService: ReflectionServiceInfo | null;
  selectedMethod: ReflectionMethodInfo | null;
  reflectionReady: boolean;
  reflectionLoading: boolean;
  protoInfo: ProtoFileInfo | null;
  onSelectService: (service: ReflectionServiceInfo) => void;
  onSelectMethod: (method: ReflectionMethodInfo) => void;
  /** Triggered when a .proto is uploaded. Receives parsed services / messages. */
  onProtoUpload: (
    file: File,
    parsed: ProtoFileInfo,
    suggested: {
      service: string;
      method: string;
      methodType: GrpcMethodType;
    } | null
  ) => void;
}

/**
 * Spatial Depth gRPC service tree (left column, 280px). Renders the
 * reflection header + status pill, services with expandable method lists,
 * and a full-width "Upload .proto" bottom CTA. Reflection state is owned by
 * the parent; this component is presentation-only besides local "expanded"
 * UI state.
 */
export function GrpcServiceTree({
  services,
  selectedService,
  selectedMethod,
  reflectionReady,
  reflectionLoading,
  protoInfo,
  onSelectService,
  onSelectMethod,
  onProtoUpload,
}: GrpcServiceTreeProps) {
  // Expanded service set defaults to the currently selected service so the
  // active method is always visible after auto-discovery / reload.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>();
    if (selectedService) s.add(selectedService.fullName);
    return s;
  });

  // Keep selected service expanded if it changes (e.g., reflection reruns).
  if (selectedService && !expanded.has(selectedService.fullName)) {
    const next = new Set(expanded);
    next.add(selectedService.fullName);
    setExpanded(next);
  }

  const totalMethods = useMemo(
    () => services.reduce((sum, s) => sum + s.methods.length, 0),
    [services]
  );

  const toggleService = (fullName: string) => {
    const next = new Set(expanded);
    if (next.has(fullName)) next.delete(fullName);
    else next.add(fullName);
    setExpanded(next);
  };

  const handleFileChange = async (file: File | null) => {
    if (!file) return;
    if (!file.name.endsWith('.proto')) {
      toast.error('Invalid file type', { description: 'Please upload a .proto file' });
      return;
    }
    try {
      const content = await file.text();
      const parsed = parseProtoFile(content);
      let suggested: {
        service: string;
        method: string;
        methodType: GrpcMethodType;
      } | null = null;
      if (parsed.services.length > 0) {
        const firstService = parsed.services[0];
        if (firstService) {
          const service = firstService.fullName;
          let method = '';
          let methodType: GrpcMethodType = 'unary';
          const firstMethod = firstService.methods[0];
          if (firstMethod) {
            method = firstMethod.name;
            if (firstMethod.clientStreaming && firstMethod.serverStreaming) {
              methodType = 'bidirectional-streaming';
            } else if (firstMethod.serverStreaming) {
              methodType = 'server-streaming';
            } else if (firstMethod.clientStreaming) {
              methodType = 'client-streaming';
            }
          }
          suggested = { service, method, methodType };
        }
        toast.success('Proto file parsed', {
          description: `Found ${parsed.services.length} service(s) and ${Object.keys(parsed.messages).length} message type(s)`,
        });
      } else {
        toast.warning('No services found', {
          description: 'The proto file does not contain any service definitions',
        });
      }
      onProtoUpload(file, parsed, suggested);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to parse proto file';
      toast.error('Proto parsing failed', { description: errorMessage });
    }
  };

  // Status pill states: READY (green) when reflection has services,
  // LOADING (amber) while discovering, IDLE (dim) otherwise.
  const pill = reflectionLoading
    ? { label: 'LOADING', fg: '#f59e0b', bg: 'rgba(245,158,11,0.16)' }
    : reflectionReady
      ? { label: 'READY', fg: '#22c55e', bg: 'rgba(34,197,94,0.16)' }
      : { label: 'IDLE', fg: 'var(--sp-text-dim)', bg: 'var(--sp-surface-lo)' };

  return (
    <Floater
      radius="panel"
      className="flex flex-col overflow-hidden h-full"
      style={{ background: 'var(--sp-surface)' }}
    >
      {/* Header: Zap icon + Reflection + status pill */}
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-1.5">
        {reflectionLoading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: '#22c55e' }} />
        ) : (
          <Zap className="h-3.5 w-3.5" style={{ color: '#22c55e' }} />
        )}
        <span className="text-sp-12-5 font-semibold text-sp-text">Reflection</span>
        <span
          className="font-mono font-bold tabular-nums"
          style={{
            fontSize: 9.5,
            letterSpacing: 0.5,
            padding: '1px 5px',
            borderRadius: 4,
            color: pill.fg,
            background: pill.bg,
          }}
        >
          {pill.label}
        </span>
      </div>

      {/* Counts row */}
      <div className="px-3.5 pb-2.5 font-mono text-sp-11 text-sp-muted tabular-nums">
        {services.length} service{services.length === 1 ? '' : 's'} ·{' '}
        {totalMethods} method{totalMethods === 1 ? '' : 's'}
      </div>

      {/* Service list */}
      <div className="flex-1 overflow-auto px-2 py-1.5 min-h-0">
        {services.length === 0 && (
          <div className="text-sp-11 text-sp-dim font-mono px-2 py-3 leading-relaxed">
            {reflectionLoading
              ? 'Discovering services…'
              : 'No services discovered yet. Set a URL and discover, or upload a .proto file.'}
          </div>
        )}
        {services.map((service) => {
          const isExpanded = expanded.has(service.fullName);
          return (
            <div key={service.fullName} className="mb-0.5">
              <button
                type="button"
                onClick={() => toggleService(service.fullName)}
                className={cn(
                  'group flex items-center gap-1.5 w-full text-left rounded-md px-2 py-1.5',
                  'font-mono text-sp-12 transition-colors',
                  isExpanded ? 'bg-sp-hover' : 'hover:bg-sp-hover'
                )}
              >
                <ChevronRight
                  className="h-2.5 w-2.5 shrink-0 transition-transform"
                  style={{
                    transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                    opacity: 0.5,
                  }}
                />
                <span className="flex-1 truncate text-sp-text">{service.fullName}</span>
                <span className="text-sp-10 text-sp-dim tabular-nums">
                  {service.methods.length}
                </span>
              </button>
              {isExpanded && (
                <div className="mt-0.5 mb-1.5">
                  {service.methods.map((m) => {
                    const kind = methodKind(m);
                    const k = KIND_COLOR[kind];
                    const isSelected =
                      selectedMethod?.fullName === m.fullName ||
                      (selectedService?.fullName === service.fullName &&
                        selectedMethod?.name === m.name);
                    return (
                      <button
                        key={m.fullName || m.name}
                        type="button"
                        onClick={() => {
                          // Selecting a method implicitly selects its service.
                          if (selectedService?.fullName !== service.fullName) {
                            onSelectService(service);
                          }
                          onSelectMethod(m);
                        }}
                        className={cn(
                          'relative flex items-center gap-1.5 w-full text-left rounded-md',
                          'pl-7 pr-2 py-1 mb-px font-mono text-sp-11-5 transition-colors'
                        )}
                        style={{
                          background: isSelected ? 'var(--sp-active-bg)' : 'transparent',
                          color: isSelected ? 'var(--sp-text)' : 'var(--sp-text-muted)',
                        }}
                        aria-current={isSelected ? 'true' : undefined}
                      >
                        {isSelected && (
                          <span
                            aria-hidden="true"
                            className="absolute"
                            style={{
                              left: 22,
                              top: '50%',
                              transform: 'translateY(-50%)',
                              width: 3,
                              height: 14,
                              borderRadius: 2,
                              background: 'var(--sp-accent)',
                              boxShadow: '0 0 6px var(--sp-accent-glow-88)',
                            }}
                          />
                        )}
                        <span
                          className="font-mono font-bold"
                          style={{
                            fontSize: 9,
                            letterSpacing: 0.5,
                            padding: '1px 4px',
                            borderRadius: 3,
                            color: k.fg,
                            background: k.bg,
                          }}
                          title={k.title}
                        >
                          {kind}
                        </span>
                        <span className="truncate">{m.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Optional .proto fact strip */}
      {protoInfo && (
        <div className="px-3.5 py-2 border-t border-sp-line font-mono text-sp-10-5 text-sp-dim leading-relaxed">
          <div className="text-sp-muted truncate">pkg {protoInfo.package || 'default'}</div>
          <div className="truncate">
            {Object.keys(protoInfo.messages).length} message types
          </div>
        </div>
      )}

      {/* Upload .proto CTA */}
      <div className="p-2.5 border-t border-sp-line">
        <label
          className={cn(
            'flex items-center justify-center gap-1.5 w-full h-8 rounded-sp-btn cursor-pointer',
            'border border-sp-line-strong bg-transparent',
            'text-sp-text text-sp-11-5 font-semibold transition-colors',
            'hover:bg-sp-hover'
          )}
        >
          <Upload className="h-3 w-3" />
          Upload .proto
          <input
            type="file"
            accept=".proto"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              void handleFileChange(f);
              // Reset so the same file can be selected again.
              e.currentTarget.value = '';
            }}
          />
        </label>
      </div>
    </Floater>
  );
}

export default GrpcServiceTree;
