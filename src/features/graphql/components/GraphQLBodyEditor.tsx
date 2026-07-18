'use client';

import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CodeEditorSkeleton } from '@/components/shared/CodeEditorSkeleton';
import { registerGraphQLCompletionProvider } from '@/features/graphql/lib/completionProvider';
import { setupDebouncedDiagnostics } from '@/features/graphql/lib/diagnosticsProvider';
import { buildSchemaFromIntrospection } from '@/features/graphql/lib/introspection';
import { generateVariablesTemplate, parseVariables } from '@/features/graphql/lib/queryParser';
import { validateQuery } from '@/features/graphql/lib/validation';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { useActiveTab } from '@/store/selectors';
import { useGraphQLSchemaStore } from '@/store/useGraphQLSchemaStore';

const CodeEditor = lazyComponent(
  () => import('@/components/shared/CodeEditor'),
  <CodeEditorSkeleton className="h-[260px]" />
);

let completionProviderRegistered = false;

interface GraphQLBodyEditorProps {
  query: string;
  variables: string;
  url: string;
  onQueryChange: (query: string) => void;
  onVariablesChange: (variables: string) => void;
}

function isVariablesValid(raw: string): boolean {
  const trimmed = (raw || '').trim();
  if (!trimmed) return true;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export default function GraphQLBodyEditor({
  query,
  variables,
  url,
  onQueryChange,
  onVariablesChange,
}: GraphQLBodyEditorProps) {
  const [showVariables, setShowVariables] = useState(true);
  const diagnosticsRef = useRef<Monaco.IDisposable | null>(null);
  const activeTabId = useActiveTab()?.id;
  const schemaResult = useGraphQLSchemaStore((s) => (url ? (s.schemas[url] ?? null) : null));

  const executableSchema = useMemo(
    () => (schemaResult ? buildSchemaFromIntrospection(schemaResult) : null),
    [schemaResult]
  );

  // Refs so Monaco providers always read the latest schema without re-registering
  const schemaRef = useRef(schemaResult);
  const executableSchemaRef = useRef(executableSchema);
  useEffect(() => {
    schemaRef.current = schemaResult;
  }, [schemaResult]);
  useEffect(() => {
    executableSchemaRef.current = executableSchema;
  }, [executableSchema]);

  const extractedVariables = useMemo(() => parseVariables(query), [query]);

  useEffect(() => {
    if (extractedVariables.length > 0 && (!variables || variables === '{}')) {
      const template = generateVariablesTemplate(extractedVariables);
      onVariablesChange(template);
    }
  }, [query, extractedVariables, variables, onVariablesChange]);

  // Validation is synchronous and purely derived from the query + schema, so
  // compute it during render rather than mirroring it into state via an effect
  // (which would force an extra render pass on every keystroke).
  const validationErrors = useMemo(
    () => (query.trim() ? validateQuery(query, executableSchema).errors.map((e) => e.message) : []),
    [query, executableSchema]
  );

  const handleQueryEditorMount = useCallback(
    (editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => {
      if (!completionProviderRegistered) {
        registerGraphQLCompletionProvider(monaco, () => schemaRef.current?.schema ?? null);
        completionProviderRegistered = true;
      }
      const model = editor.getModel();
      if (model) {
        diagnosticsRef.current?.dispose();
        diagnosticsRef.current = setupDebouncedDiagnostics(
          monaco,
          model,
          () => executableSchemaRef.current
        );
      }
    },
    []
  );

  useEffect(
    () => () => {
      diagnosticsRef.current?.dispose();
    },
    []
  );

  const variablesValid = isVariablesValid(variables);

  return (
    <div className="flex flex-col h-full">
      {/* Validation errors banner */}
      {validationErrors.length > 0 && (
        <div
          className="mx-3 mt-2 mb-1 px-2 py-1.5 rounded-sp-btn border text-sp-11 font-mono"
          style={{
            background: 'color-mix(in srgb, var(--color-danger) 8%, transparent)',
            borderColor: 'color-mix(in srgb, var(--color-danger) 25%, transparent)',
            color: '#fca5a5',
          }}
        >
          {validationErrors.slice(0, 3).map((error, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          ))}
          {validationErrors.length > 3 && (
            <div className="text-sp-dim mt-1">
              …and {validationErrors.length - 3} more error
              {validationErrors.length - 3 === 1 ? '' : 's'}
            </div>
          )}
        </div>
      )}

      {/* Query editor — rendered inside a CodeEditorFrame-like dark surface */}
      <div className="flex-1 min-h-0 px-3 pt-2 pb-2">
        <div
          className="rounded-sp-panel border border-sp-line overflow-hidden h-full"
          style={{ background: 'var(--sp-code)' }}
        >
          <CodeEditor
            value={query}
            onChange={onQueryChange}
            language="graphql"
            height="100%"
            onEditorMount={handleQueryEditorMount}
            {...(activeTabId ? { path: `tab-${activeTabId}-graphql-query` } : {})}
          />
        </div>
      </div>

      {/* Variables strip — chevron + sp-label + valid/invalid tag */}
      <div className="border-t border-sp-line shrink-0">
        <button
          type="button"
          onClick={() => setShowVariables((v) => !v)}
          className="flex items-center gap-2 w-full text-left px-3 h-8 hover:bg-sp-hover transition-colors"
          aria-expanded={showVariables}
        >
          {showVariables ? (
            <ChevronDown className="h-3 w-3 text-sp-dim" />
          ) : (
            <ChevronRight className="h-3 w-3 text-sp-dim" />
          )}
          <span className="sp-label">Variables</span>
          <span className="text-sp-dim text-sp-11 font-mono">·</span>
          <span
            className="inline-flex items-center gap-1 sp-label"
            style={{
              color: variablesValid ? 'var(--color-success)' : 'var(--color-danger)',
            }}
          >
            {variablesValid ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : (
              <AlertCircle className="h-3 w-3" />
            )}
            {variablesValid ? 'valid' : 'invalid'}
          </span>
          {extractedVariables.length > 0 && (
            <span className="ml-auto text-sp-dim text-sp-10 font-mono">
              {extractedVariables.length} detected
            </span>
          )}
        </button>

        {showVariables && (
          <div className="px-3 pb-3">
            <div
              className="rounded-sp-panel border border-sp-line overflow-hidden"
              style={{ background: 'var(--sp-code)' }}
            >
              <CodeEditor
                value={variables || '{}'}
                onChange={onVariablesChange}
                language="json"
                height="140px"
                {...(activeTabId ? { path: `tab-${activeTabId}-graphql-variables` } : {})}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
