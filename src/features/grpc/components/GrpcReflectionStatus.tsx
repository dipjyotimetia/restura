import { AlertCircle, CheckCircle, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatMessageSchemaForDisplay } from '@/features/grpc/lib/grpcReflection';
import type { ReflectionMethodInfo, ReflectionResult } from '@/types';

interface GrpcReflectionStatusProps {
  result: ReflectionResult;
  selectedMethod: ReflectionMethodInfo | null;
  showSchema: boolean;
  onToggleSchema: () => void;
}

/**
 * Status banner under the URL row showing the most recent reflection
 * result — service/method counts, current selection, optional schema
 * dump. Pure presentation; the parent owns reflection state.
 */
export function GrpcReflectionStatus({
  result,
  selectedMethod,
  showSchema,
  onToggleSchema,
}: GrpcReflectionStatusProps) {
  return (
    <div
      className={`mx-3 mb-2 p-2 rounded text-xs space-y-1 ${result.success ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}
    >
      <div className="flex items-center gap-1 font-mono font-medium">
        <Radio className="h-3 w-3" />
        gRPC Reflection
        {result.success ? (
          <CheckCircle className="h-3 w-3 text-emerald-400" />
        ) : (
          <AlertCircle className="h-3 w-3 text-destructive" />
        )}
      </div>
      {result.success ? (
        <>
          <div className="font-mono text-muted-foreground">
            Services: {result.services.length} · Methods:{' '}
            {result.services.reduce((sum, s) => sum + s.methods.length, 0)}
          </div>
          {selectedMethod && (
            <div className="mt-1">
              <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
                Selected Method
              </div>
              <div className="font-mono text-xs">
                In: {selectedMethod.inputType.split('.').pop()} · Out:{' '}
                {selectedMethod.outputType.split('.').pop()}
              </div>
              <Button
                variant="link"
                size="sm"
                className="p-0 h-auto text-xs font-mono"
                onClick={onToggleSchema}
              >
                {showSchema ? 'Hide Schema' : 'Show Schema'}
              </Button>
              {showSchema && selectedMethod.inputMessageSchema && (
                <pre className="mt-1 p-2 glass-3 glass-border-subtle border rounded text-xs overflow-x-auto font-mono">
                  {formatMessageSchemaForDisplay(selectedMethod.inputMessageSchema)}
                </pre>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="font-mono text-destructive">{result.error}</div>
      )}
    </div>
  );
}

export default GrpcReflectionStatus;
