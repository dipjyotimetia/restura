import { AlertCircle } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { lazyComponent } from '@/lib/shared/lazyComponent';

const CodeEditor = lazyComponent(
  () => import('@/components/shared/CodeEditor'),
  <div className="h-[400px] border border-border rounded-lg p-4 space-y-2 bg-background">
    <Skeleton className="h-3.5 w-3/4 rounded" />
    <Skeleton className="h-3.5 w-1/2 rounded" />
    <Skeleton className="h-3.5 w-2/3 rounded" />
    <Skeleton className="h-3.5 w-4/5 rounded" />
  </div>
);

interface GrpcMessageEditorProps {
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  isValid: boolean;
  /** Stable Monaco model path so editor state survives tab switches */
  editorPath?: string | undefined;
}

/**
 * Monaco-based JSON editor for the gRPC request message body.
 * Pure leaf component — owns no state; all formatting / validation
 * happens in the parent (GrpcRequestBuilder).
 */
export function GrpcMessageEditor({
  value,
  onChange,
  error,
  isValid,
  editorPath,
}: GrpcMessageEditorProps) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground font-mono mb-2">
        Request message as JSON. Use {'{{variable}}'} for environment variables.
      </p>
      {!isValid && error && (
        <div className="text-xs text-destructive flex items-center gap-1 mb-2">
          <AlertCircle className="h-3 w-3" />
          {error}
        </div>
      )}
      <CodeEditor
        value={value || '{}'}
        onChange={onChange}
        language="json"
        height="400px"
        path={editorPath}
      />
    </div>
  );
}

export default GrpcMessageEditor;
