import type * as Monaco from 'monaco-editor';
import { GraphQLSchema } from 'graphql';
import { validateQuery, ValidationError } from './validation';

// Convert validation errors to Monaco markers
export function createDiagnostics(
  errors: ValidationError[],
  _model: Monaco.editor.ITextModel
): Monaco.editor.IMarkerData[] {
  return errors.map((error) => ({
    severity: 8, // MarkerSeverity.Error
    message: error.message,
    startLineNumber: error.line,
    startColumn: error.column,
    endLineNumber: error.endLine || error.line,
    endColumn: error.endColumn || error.column + 1,
  }));
}

// Set up diagnostics for a Monaco model
export function setupDiagnostics(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  getSchema: () => GraphQLSchema | null
): Monaco.IDisposable {
  const owner = 'graphql-diagnostics';

  // Initial validation
  updateDiagnostics();

  // Update on content change
  const disposable = model.onDidChangeContent(() => {
    updateDiagnostics();
  });

  function updateDiagnostics() {
    const query = model.getValue();
    const schema = getSchema();
    const result = validateQuery(query, schema);
    const markers = createDiagnostics(result.errors, model);
    monaco.editor.setModelMarkers(model, owner, markers);
  }

  return {
    dispose: () => {
      disposable.dispose();
      monaco.editor.setModelMarkers(model, owner, []);
    },
  };
}

// Debounced diagnostics setup for better performance
export function setupDebouncedDiagnostics(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  getSchema: () => GraphQLSchema | null,
  delay: number = 300
): Monaco.IDisposable {
  const owner = 'graphql-diagnostics';
  let timeoutId: NodeJS.Timeout | null = null;

  // Initial validation
  updateDiagnostics();

  // Update on content change with debounce
  const disposable = model.onDidChangeContent(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(updateDiagnostics, delay);
  });

  function updateDiagnostics() {
    const query = model.getValue();
    const schema = getSchema();
    const result = validateQuery(query, schema);
    const markers = createDiagnostics(result.errors, model);
    monaco.editor.setModelMarkers(model, owner, markers);
  }

  return {
    dispose: () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      disposable.dispose();
      monaco.editor.setModelMarkers(model, owner, []);
    },
  };
}
