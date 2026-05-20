import { Floater } from '@/components/ui/spatial';
import { formatMessageSchemaForDisplay } from '@/features/grpc/lib/grpcReflection';
import type { GrpcMethodType, ReflectionMethodInfo } from '@/types';

const METHOD_TYPE_DESC: Record<GrpcMethodType, string> = {
  unary: 'Single request, single response',
  'server-streaming': 'Single request, streamed responses',
  'client-streaming': 'Streamed requests, single response',
  'bidirectional-streaming': 'Streamed requests and responses',
};

export interface GrpcMethodContextProps {
  methodName: string;
  methodType: GrpcMethodType;
  selectedMethod: ReflectionMethodInfo | null;
  showSchema: boolean;
  onToggleSchema: () => void;
}

function shortType(name: string | undefined): string {
  if (!name) return '—';
  const last = name.split('.').pop();
  return last || name;
}

/**
 * Floater showing the currently selected method's name, signature
 * (in/out types), description, and a "Show schema" toggle. Pure
 * presentation — the schema panel collapse/expand is parent-owned.
 */
export function GrpcMethodContext({
  methodName,
  methodType,
  selectedMethod,
  showSchema,
  onToggleSchema,
}: GrpcMethodContextProps) {
  const displayName = methodName || selectedMethod?.name || 'method';
  const inputType = shortType(selectedMethod?.inputType);
  const outputType = shortType(selectedMethod?.outputType);
  const description = METHOD_TYPE_DESC[methodType];

  return (
    <Floater radius="btn" className="px-3.5 py-2.5" style={{ background: 'var(--sp-surface)' }}>
      <div className="flex items-baseline gap-2 mb-1.5">
        <span
          className="font-mono font-bold text-sp-text"
          style={{ fontSize: 14, color: 'var(--sp-accent)' }}
        >
          {displayName}
        </span>
        <span className="text-sp-11 text-sp-muted">· {description}</span>
      </div>

      <div className="flex items-center gap-4 font-mono text-sp-11-5">
        <span>
          <span className="text-sp-dim">in </span>
          <span style={{ color: '#a78bfa' }}>{inputType}</span>
        </span>
        <span className="text-sp-dim">→</span>
        <span>
          <span className="text-sp-dim">out </span>
          <span style={{ color: '#a78bfa' }}>{outputType}</span>
        </span>
        <div className="flex-1" />
        {selectedMethod?.inputMessageSchema && (
          <button
            type="button"
            onClick={onToggleSchema}
            className="text-sp-11-5 font-mono cursor-pointer transition-colors"
            style={{
              color: 'var(--sp-accent)',
              textDecoration: 'underline',
              textDecorationStyle: 'dotted',
              textUnderlineOffset: 3,
            }}
            aria-expanded={showSchema}
          >
            {showSchema ? 'Hide schema' : 'Show schema'}
          </button>
        )}
      </div>

      {showSchema && selectedMethod?.inputMessageSchema && (
        <pre
          className="mt-2.5 p-2.5 rounded-md font-mono text-sp-11 overflow-x-auto"
          style={{
            background: 'var(--sp-code)',
            border: '1px solid var(--sp-line)',
            color: 'var(--sp-text)',
          }}
        >
          {formatMessageSchemaForDisplay(selectedMethod.inputMessageSchema)}
        </pre>
      )}
    </Floater>
  );
}

export default GrpcMethodContext;
