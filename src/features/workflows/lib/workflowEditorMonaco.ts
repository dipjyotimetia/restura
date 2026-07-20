import {
  BINDINGS_SCHEMA_URI,
  RESTURA_BINDINGS_SCHEMA,
  RESTURA_OWS_SCHEMA,
  WORKFLOW_SCHEMA_URI,
} from './workflowEditorSchemas';

export type WorkflowEditorDocument = 'workflow' | 'bindings';

let schemasRegistered = false;

interface JsonSchemaAssociation {
  uri?: string;
  fileMatch?: string[];
  schema?: object;
}

interface JsonDiagnosticsOptions {
  validate?: boolean;
  allowComments?: boolean;
  schemas?: JsonSchemaAssociation[];
}

export interface MonacoJsonDefaults {
  diagnosticsOptions: JsonDiagnosticsOptions;
  setDiagnosticsOptions: (options: JsonDiagnosticsOptions) => void;
}

/** Stable model URIs scope JSON schemas and preserve Monaco view state per workflow tab. */
export function workflowEditorModelPath(
  workflowId: string,
  document: WorkflowEditorDocument
): string {
  const filename = document === 'workflow' ? 'workflow.ows.json' : 'bindings.restura.json';
  return `inmemory://restura-workflows/${encodeURIComponent(workflowId)}/${filename}`;
}

/**
 * Register bundled schemas with Monaco's self-hosted JSON worker. No schema is
 * fetched at runtime and persisted workflow artifacts never receive $schema.
 */
export function registerWorkflowEditorSchemas(defaults: MonacoJsonDefaults): void {
  if (schemasRegistered) return;
  const existing = defaults.diagnosticsOptions.schemas ?? [];
  defaults.setDiagnosticsOptions({
    ...defaults.diagnosticsOptions,
    validate: true,
    allowComments: false,
    schemas: [
      ...existing.filter(
        (schema: JsonSchemaAssociation) =>
          schema.uri !== WORKFLOW_SCHEMA_URI && schema.uri !== BINDINGS_SCHEMA_URI
      ),
      {
        uri: WORKFLOW_SCHEMA_URI,
        fileMatch: ['inmemory://restura-workflows/**/workflow.ows.json'],
        schema: RESTURA_OWS_SCHEMA,
      },
      {
        uri: BINDINGS_SCHEMA_URI,
        fileMatch: ['inmemory://restura-workflows/**/bindings.restura.json'],
        schema: RESTURA_BINDINGS_SCHEMA,
      },
    ],
  });
  schemasRegistered = true;
}
