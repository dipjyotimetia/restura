import { AlertCircle } from 'lucide-react';
import { CodeEditorSkeleton } from '@/components/shared/CodeEditorSkeleton';
import { lazyComponent } from '@/lib/shared/lazyComponent';

const CodeEditor = lazyComponent(
  () => import('@/components/shared/CodeEditor'),
  <CodeEditorSkeleton className="h-[400px]" />
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
