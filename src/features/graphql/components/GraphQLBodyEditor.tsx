'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { useGraphQLSchemaStore } from '@/store/useGraphQLSchemaStore';
import { parseVariables, generateVariablesTemplate } from '@/features/graphql/lib/queryParser';
import { formatQuery } from '@/features/graphql/lib/formatter';
import { validateQuery } from '@/features/graphql/lib/validation';
import { buildSchemaFromIntrospection } from '@/features/graphql/lib/introspection';
import {
  Loader2,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Wand2,
  PanelRightClose,
  PanelRight,
} from 'lucide-react';
import { lazy } from 'react';

const CodeEditor = lazy(() => import('@/components/shared/CodeEditor'));
const SchemaExplorer = lazy(() => import('./SchemaExplorer'));

interface GraphQLBodyEditorProps {
  query: string;
  variables: string;
  url: string;
  onQueryChange: (query: string) => void;
  onVariablesChange: (variables: string) => void;
}

export default function GraphQLBodyEditor({
  query,
  variables,
  url,
  onQueryChange,
  onVariablesChange,
}: GraphQLBodyEditorProps) {
  const [showVariables, setShowVariables] = useState(true);
  const [showExplorer, setShowExplorer] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const { fetchSchema, getSchema, isLoading } = useGraphQLSchemaStore();

  const schemaResult = url ? getSchema(url) : null;
  const loading = url ? isLoading(url) : false;

  // Build executable schema for validation
  const executableSchema = schemaResult ? buildSchemaFromIntrospection(schemaResult) : null;

  // Extract variables from query
  const extractedVariables = parseVariables(query);

  // Auto-generate variables template when query changes
  useEffect(() => {
    if (extractedVariables.length > 0 && (!variables || variables === '{}')) {
      const template = generateVariablesTemplate(extractedVariables);
      onVariablesChange(template);
    }
  }, [query, extractedVariables.length]);

  // Validate query when it changes
  useEffect(() => {
    if (query.trim()) {
      const result = validateQuery(query, executableSchema);
      setValidationErrors(result.errors.map(e => e.message));
    } else {
      setValidationErrors([]);
    }
  }, [query, executableSchema]);

  // Auto-fetch schema when URL changes
  useEffect(() => {
    if (url && url.trim()) {
      const timer = setTimeout(() => {
        if (!schemaResult) {
          fetchSchema(url);
        }
      }, 1000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [url, schemaResult, fetchSchema]);

  const handleFetchSchema = useCallback(async () => {
    if (!url) return;
    await fetchSchema(url);
  }, [url, fetchSchema]);

  const handlePrettify = () => {
    const formatted = formatQuery(query);
    onQueryChange(formatted);
  };

  const handleFieldSelect = (field: string) => {
    // Insert field at cursor or append
    onQueryChange(query + '\n  ' + field);
  };

  const getSchemaStatus = () => {
    if (!url) return null;
    if (loading) return { icon: Loader2, text: 'Loading schema...', color: 'text-yellow-500', spin: true };
    if (schemaResult?.success) return { icon: CheckCircle, text: 'Schema loaded', color: 'text-green-500', spin: false };
    if (schemaResult && !schemaResult.success) return { icon: AlertCircle, text: schemaResult.error || 'Failed to load', color: 'text-red-500', spin: false };
    return null;
  };

  const status = getSchemaStatus();

  return (
    <div className="flex gap-4">
      {/* Main Editor */}
      <div className="flex-1 space-y-4">
        {/* Schema Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={handleFetchSchema}
            disabled={!url || loading}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Fetch Schema
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handlePrettify}
            disabled={!query.trim()}
          >
            <Wand2 className="h-4 w-4 mr-2" />
            Prettify
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowExplorer(!showExplorer)}
          >
            {showExplorer ? (
              <PanelRightClose className="h-4 w-4 mr-2" />
            ) : (
              <PanelRight className="h-4 w-4 mr-2" />
            )}
            Explorer
          </Button>
          {status && (
            <div className={`flex items-center gap-1 text-xs ${status.color}`}>
              <status.icon className={`h-3 w-3 ${status.spin ? 'animate-spin' : ''}`} />
              <span>{status.text}</span>
            </div>
          )}
          {schemaResult?.success && schemaResult.schema && (
            <span className="text-xs text-muted-foreground">
              {schemaResult.schema.types.filter(t => !t.name?.startsWith('__')).length} types
            </span>
          )}
        </div>

        {/* Validation Errors */}
        {validationErrors.length > 0 && (
          <div className="p-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-500">
            {validationErrors.slice(0, 3).map((error, i) => (
              <div key={i} className="flex items-start gap-1">
                <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            ))}
            {validationErrors.length > 3 && (
              <div className="text-muted-foreground mt-1">
                ...and {validationErrors.length - 3} more errors
              </div>
            )}
          </div>
        )}

        {/* Query Editor */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Query</span>
            <span className="text-xs text-muted-foreground">
              {new Blob([query]).size} bytes
            </span>
          </div>
          <CodeEditor
            value={query}
            onChange={onQueryChange}
            language="graphql"
            height="250px"
          />
        </div>

        {/* Variables Section */}
        <div className="space-y-2">
          <button
            onClick={() => setShowVariables(!showVariables)}
            className="flex items-center gap-2 text-sm font-medium hover:text-primary transition-colors"
          >
            {showVariables ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
            Variables
            {extractedVariables.length > 0 && (
              <span className="text-xs text-muted-foreground">
                ({extractedVariables.length} detected)
              </span>
            )}
          </button>

          {showVariables && (
            <div className="space-y-2">
              {/* Detected variables info */}
              {extractedVariables.length > 0 && (
                <div className="text-xs text-muted-foreground p-2 bg-muted rounded">
                  Detected: {extractedVariables.map(v => (
                    <span key={v.name} className="inline-block mr-2">
                      <code className="text-primary">${v.name}</code>
                      <span className="text-muted-foreground">: {v.type}</span>
                    </span>
                  ))}
                </div>
              )}

              <CodeEditor
                value={variables || '{}'}
                onChange={onVariablesChange}
                language="json"
                height="150px"
              />
            </div>
          )}
        </div>
      </div>

      {/* Schema Explorer Panel */}
      {showExplorer && (
        <div className="w-64 border-l border-border">
          <SchemaExplorer
            schema={schemaResult?.schema || null}
            onFieldSelect={handleFieldSelect}
          />
        </div>
      )}
    </div>
  );
}
