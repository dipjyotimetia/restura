import { AlertCircle } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CodeEditorSkeleton } from '@/components/shared/CodeEditorSkeleton';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { useActiveRequest, useActiveResponse } from '@/store/selectors';
import type { GrpcResponse } from '@/types';
import {
  fieldViolationsOf,
  inputDescriptorFor,
  type LocatedViolation,
  locateFieldViolations,
} from '../lib/grpcFieldViolations';
import { useGrpcViolationFocus } from '../lib/grpcViolationFocus';

const CodeEditor = lazyComponent(
  () => import('@/components/shared/CodeEditor'),
  <CodeEditorSkeleton className="h-[360px]" />
);

/** Monaco marker owner for server-reported field violations. */
export const FIELD_VIOLATION_MARKER_OWNER = 'grpc-field-violations';

interface GrpcMessageEditorProps {
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  isValid: boolean;
  /** Stable Monaco model path so editor state survives tab switches */
  editorPath?: string | undefined;
  /** Request tab responsible for disposing the retained model. */
  modelOwner?: string | undefined;
}

interface MonacoHandles {
  editor: Monaco.editor.IStandaloneCodeEditor;
  monaco: typeof Monaco;
  model: Monaco.editor.ITextModel;
}

function toMonacoRange(model: Monaco.editor.ITextModel, range: { start: number; end: number }) {
  const start = model.getPositionAt(range.start);
  const end = model.getPositionAt(range.end);
  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
  };
}

function markerMessage(v: LocatedViolation): string {
  const reason = v.reason ? ` [${v.reason}]` : '';
  const where = v.exact ? '' : ' (field not present in the request)';
  return `${v.field || '(request)'}: ${v.description || 'rejected by the server'}${reason}${where}`;
}

/**
 * The active response's `google.rpc.BadRequest` field violations located in
 * this editor's text (#941), using the request's schema snapshot (when it has
 * one) to map proto field names onto the JSON keys.
 */
function useLocatedViolations(value: string): LocatedViolation[] {
  const response = useActiveResponse();
  const request = useActiveRequest('grpc');
  const violations = useMemo(
    () =>
      fieldViolationsOf(
        response && 'grpcStatus' in response ? (response as GrpcResponse).statusDetails : undefined
      ),
    [response]
  );
  const hasViolations = violations.length > 0;
  const schema = request?.schema;
  const service = request?.service ?? '';
  const method = request?.method ?? '';
  const input = useMemo(
    () => (hasViolations ? inputDescriptorFor(schema, service, method) : undefined),
    [hasViolations, schema, service, method]
  );
  return useMemo(
    () => (hasViolations ? locateFieldViolations(value || '{}', violations, input) : []),
    [hasViolations, value, violations, input]
  );
}

/**
 * Monaco-based JSON editor for the gRPC request message body. The Monaco
 * editor brings its own gutter/syntax styling, so this component wraps it
 * in a Spatial Depth frame (rounded border, code-surface background) rather
 * than the atom `<CodeEditorFrame>` which would render a second gutter.
 *
 * Server-reported field violations from the active response are shown as
 * inline error markers, and a jump request from the response panel reveals and
 * selects the offending field.
 */
export function GrpcMessageEditor({
  value,
  onChange,
  error,
  isValid,
  editorPath,
  modelOwner,
}: GrpcMessageEditorProps) {
  const [handles, setHandles] = useState<MonacoHandles | null>(null);
  const handlesRef = useRef<MonacoHandles | null>(null);
  const located = useLocatedViolations(value);
  const pending = useGrpcViolationFocus((s) => s.pending);
  const consume = useGrpcViolationFocus((s) => s.consume);

  const handleModelChange = useCallback(
    (
      editor: Monaco.editor.IStandaloneCodeEditor,
      monaco: typeof Monaco,
      model: Monaco.editor.ITextModel
    ) => {
      const next = { editor, monaco, model };
      handlesRef.current = next;
      setHandles(next);
    },
    []
  );

  // Inline diagnostics: one error marker per locatable violation.
  useEffect(() => {
    if (!handles) return;
    const { monaco, model } = handles;
    const markers = located
      .filter((v) => v.range)
      .map((v) => ({
        ...toMonacoRange(model, v.range as { start: number; end: number }),
        severity: monaco.MarkerSeverity.Error,
        message: markerMessage(v),
        source: 'gRPC server',
      }));
    monaco.editor.setModelMarkers(model, FIELD_VIOLATION_MARKER_OWNER, markers);
  }, [handles, located]);

  // Drop the markers when the editor goes away (the model may be retained).
  useEffect(
    () => () => {
      const h = handlesRef.current;
      h?.monaco.editor.setModelMarkers(h.model, FIELD_VIOLATION_MARKER_OWNER, []);
    },
    []
  );

  // Click-to-jump from the response panel.
  useEffect(() => {
    if (!pending || !handles || pending.tabId !== modelOwner) return;
    const target = located[pending.index];
    if (target?.range) {
      const range = toMonacoRange(handles.model, target.range);
      handles.editor.revealRangeInCenter(range);
      handles.editor.setSelection(range);
      handles.editor.focus();
    }
    consume(pending.nonce);
  }, [pending, handles, located, modelOwner, consume]);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sp-11 text-sp-muted font-mono">
        Request message as JSON. Use{' '}
        <span style={{ color: 'var(--color-warning)' }}>{'{{variable}}'}</span> for environment
        variables.
      </p>
      {!isValid && error && (
        <div
          className="flex items-center gap-1.5 text-sp-11 font-mono"
          role="alert"
          style={{ color: 'var(--color-danger)' }}
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
          ariaLabel="gRPC request message"
          formatOnMount={false}
          onModelChange={handleModelChange}
          {...(editorPath ? { path: editorPath } : {})}
          {...(modelOwner ? { modelOwner } : {})}
        />
      </div>
      {located.length > 0 && (
        <p className="text-sp-11 font-mono" style={{ color: 'var(--color-danger)' }}>
          The server rejected {located.length} field{located.length === 1 ? '' : 's'} — see the
          markers above or the response&apos;s Error details tab.
        </p>
      )}
    </div>
  );
}

export default GrpcMessageEditor;
