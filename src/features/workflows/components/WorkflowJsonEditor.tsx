'use client';

import type * as Monaco from 'monaco-editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CodeEditorSkeleton } from '@/components/shared/CodeEditorSkeleton';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import {
  getWorkflowBindingsDiagnostics,
  getWorkflowProfileDiagnostics,
  type WorkflowEditorDiagnostic,
} from '../lib/workflowEditorDiagnostics';
import {
  type MonacoJsonDefaults,
  registerWorkflowEditorSchemas,
  type WorkflowEditorDocument,
} from '../lib/workflowEditorMonaco';

const CodeEditor = lazyComponent(
  () => import('@/components/shared/CodeEditor'),
  <CodeEditorSkeleton className="h-[420px]" />
);

const MARKER_OWNER = 'restura-workflow-editor';
const SEMANTIC_DEBOUNCE_MS = 300;

interface Problem {
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

interface WorkflowJsonEditorProps {
  ariaLabel: string;
  document: WorkflowEditorDocument;
  modelPath: string;
  value: string;
  workflowSource: string;
  onChange: (value: string) => void;
}

function toMarkers(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  diagnostics: WorkflowEditorDiagnostic[]
): Monaco.editor.IMarkerData[] {
  return diagnostics.map((diagnostic) => {
    const start = model.getPositionAt(diagnostic.range?.start ?? 0);
    const end = model.getPositionAt(diagnostic.range?.end ?? model.getValueLength());
    return {
      severity: monaco.MarkerSeverity.Error,
      message: diagnostic.message,
      source: 'Restura workflow profile',
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    };
  });
}

/**
 * Advanced JSON surface for one workflow artifact. Monaco supplies immediate
 * JSON/schema feedback; Restura markers are intentionally advisory and use
 * the same profile/artifact rules enforced again by Validate & save.
 */
export function WorkflowJsonEditor({
  ariaLabel,
  document,
  modelPath,
  value,
  workflowSource,
  onChange,
}: WorkflowJsonEditorProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const workflowSourceRef = useRef(workflowSource);
  const validateRef = useRef<(() => void) | null>(null);
  const scheduleValidationRef = useRef<(() => void) | null>(null);
  const mountCleanupRef = useRef<(() => void) | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);

  useEffect(() => {
    workflowSourceRef.current = workflowSource;
    scheduleValidationRef.current?.();
  }, [workflowSource]);

  useEffect(
    () => () => {
      mountCleanupRef.current?.();
    },
    []
  );

  const updateProblems = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monaco || !model) return;
    setProblems(
      monaco.editor
        .getModelMarkers({ resource: model.uri })
        .filter((marker) => marker.severity >= monaco.MarkerSeverity.Warning)
        .map((marker) => ({
          message: marker.message,
          startLineNumber: marker.startLineNumber,
          startColumn: marker.startColumn,
          endLineNumber: marker.endLineNumber,
          endColumn: marker.endColumn,
        }))
    );
  }, []);

  const handleMount = useCallback(
    (
      editor: Monaco.editor.IStandaloneCodeEditor,
      monaco: typeof Monaco,
      jsonDefaults: MonacoJsonDefaults
    ) => {
      mountCleanupRef.current?.();
      registerWorkflowEditorSchemas(jsonDefaults);
      editorRef.current = editor;
      monacoRef.current = monaco;
      const model = editor.getModel();
      if (!model) return;

      const validate = () => {
        const source = model.getValue();
        const diagnostics =
          document === 'workflow'
            ? getWorkflowProfileDiagnostics(source)
            : getWorkflowBindingsDiagnostics(source, workflowSourceRef.current);
        monaco.editor.setModelMarkers(model, MARKER_OWNER, toMarkers(monaco, model, diagnostics));
        updateProblems();
      };
      validateRef.current = validate;
      validate();

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const scheduleValidation = () => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(validate, SEMANTIC_DEBOUNCE_MS);
      };
      scheduleValidationRef.current = scheduleValidation;
      const contentDisposable = model.onDidChangeContent(scheduleValidation);
      const markerDisposable = monaco.editor.onDidChangeMarkers((resources) => {
        if (resources.some((resource) => resource.toString() === model.uri.toString())) {
          updateProblems();
        }
      });
      mountCleanupRef.current = () => {
        if (timeout) clearTimeout(timeout);
        contentDisposable.dispose();
        markerDisposable.dispose();
        monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
        validateRef.current = null;
        scheduleValidationRef.current = null;
      };
    },
    [document, updateProblems]
  );

  const focusProblem = (problem: Problem) => {
    const editor = editorRef.current;
    if (!editor) return;
    const range = {
      startLineNumber: problem.startLineNumber,
      startColumn: problem.startColumn,
      endLineNumber: problem.endLineNumber,
      endColumn: problem.endColumn,
    };
    editor.revealRangeInCenter(range);
    editor.setSelection(range);
    editor.focus();
  };

  return (
    <div className="min-h-0 flex flex-1 flex-col gap-2">
      <CodeEditor
        value={value}
        onChange={onChange}
        language="json"
        height="420px"
        minimap
        showCopyButton={false}
        path={modelPath}
        ariaLabel={ariaLabel}
        formatOnMount={false}
        onEditorMount={handleMount}
      />
      <section
        aria-label={`${ariaLabel} problems`}
        className="rounded-md border border-border bg-muted/30"
      >
        <div className="px-3 py-2 text-xs font-medium text-muted-foreground">
          {problems.length === 0
            ? 'Problems: none'
            : `Problems: ${problems.length} ${problems.length === 1 ? 'issue' : 'issues'}`}
        </div>
        {problems.length > 0 && (
          <ul className="max-h-28 overflow-auto border-t border-border p-1">
            {problems.map((problem) => (
              <li key={`${problem.message}-${problem.startLineNumber}-${problem.startColumn}`}>
                <button
                  type="button"
                  className="w-full rounded px-2 py-1 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => focusProblem(problem)}
                >
                  Line {problem.startLineNumber}, column {problem.startColumn}: {problem.message}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
