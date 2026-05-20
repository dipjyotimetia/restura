import { AlertCircle } from 'lucide-react';
import { CodeEditorSkeleton } from '@/components/shared/CodeEditorSkeleton';
import { lazyComponent } from '@/lib/shared/lazyComponent';

const CodeEditor = lazyComponent(
  () => import('@/components/shared/CodeEditor'),
  <CodeEditorSkeleton className="h-[360px]" />
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
 * Monaco-based JSON editor for the gRPC request message body. The Monaco
 * editor brings its own gutter/syntax styling, so this component wraps it
 * in a Spatial Depth frame (rounded border, code-surface background) rather
 * than the atom `<CodeEditorFrame>` which would render a second gutter.
 */
export function GrpcMessageEditor({
  value,
  onChange,
  error,
  isValid,
  editorPath,
}: GrpcMessageEditorProps) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sp-11 text-sp-muted font-mono">
        Request message as JSON. Use{' '}
        <span style={{ color: '#f59e0b' }}>{'{{variable}}'}</span> for environment
        variables.
      </p>
      {!isValid && error && (
        <div
          className="flex items-center gap-1.5 text-sp-11 font-mono"
          role="alert"
          style={{ color: '#ef4444' }}
        >
          <AlertCircle className="h-3 w-3" />
          {error}
        </div>
      )}
      <div
        className="rounded-sp-panel overflow-hidden border"
        style={{
          background: 'var(--sp-code)',
          borderColor: 'var(--sp-line)',
        }}
      >
        <CodeEditor
          value={value || '{}'}
          onChange={onChange}
          language="json"
          height="360px"
          {...(editorPath ? { path: editorPath } : {})}
        />
      </div>
    </div>
  );
}

export default GrpcMessageEditor;
