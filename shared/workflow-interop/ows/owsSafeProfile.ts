import {
  Classes,
  buildFlatGraph,
  buildGraph,
  validate,
  type FlatGraph,
  type Graph,
  type Specification,
} from '@openworkflowspec/sdk';
import { z } from 'zod';
import type { RequestMode } from '../../types/request';

/** Restura-owned binding manifest version. OWS document validation remains SDK-owned. */
export const OWS_BINDING_MANIFEST_VERSION = 1 as const;

const RESTURA_PROTOCOLS = [
  'http',
  'grpc',
  'graphql',
  'websocket',
  'sse',
  'mcp',
  'kafka',
  'mqtt',
  'socketio',
] as const satisfies readonly RequestMode[];

const ResturaProtocolSchema = z.enum(RESTURA_PROTOCOLS);

const OwsActionBindingSchema = z
  .object({
    taskPath: z.string().min(1),
    protocol: ResturaProtocolSchema,
    requestId: z.string().min(1),
  })
  .strict();

export const OwsBindingManifestSchema = z
  .object({
    schemaVersion: z.literal(OWS_BINDING_MANIFEST_VERSION),
    workflowId: z.string().min(1),
    bindings: z.array(OwsActionBindingSchema),
  })
  .strict()
  .superRefine((manifest, context) => {
    const boundTasks = new Set<string>();
    for (const [index, binding] of manifest.bindings.entries()) {
      if (boundTasks.has(binding.taskPath)) {
        context.addIssue({
          code: 'custom',
          message: `Task ${binding.taskPath} is bound more than once.`,
          path: ['bindings', index, 'taskPath'],
        });
      }
      boundTasks.add(binding.taskPath);
    }
  });

export type OwsBindingManifest = z.infer<typeof OwsBindingManifestSchema>;
export type OwsActionBinding = z.infer<typeof OwsActionBindingSchema>;
export type OwsWorkflow = Specification.Workflow;

export interface OwsSafeProfileDiagnostic {
  code:
    | 'sdk-validation'
    | 'unsupported-task'
    | 'unsupported-declaration'
    | 'unsupported-task-field'
    | 'unsupported-call-argument'
    | 'embedded-credential'
    | 'inline-credential'
    | 'invalid-binding-manifest'
    | 'unknown-binding-task'
    | 'binding-target-not-call'
    | 'incompatible-binding'
    | 'unbound-call';
  path: string;
  message: string;
}

export interface CompiledOwsSafeWorkflow {
  workflow: OwsWorkflow;
  graph: Graph;
  flatGraph: FlatGraph;
  manifest: OwsBindingManifest;
  taskPaths: readonly string[];
}

export type OwsSafeWorkflowResult =
  | { ok: true; workflow: CompiledOwsSafeWorkflow }
  | { ok: false; diagnostics: readonly OwsSafeProfileDiagnostic[] };

const ALLOWED_CALLS = new Set(['http', 'grpc', 'mcp', 'openapi', 'asyncapi']);
const ALLOWED_TASKS = new Set(['call', 'do', 'fork', 'for', 'switch', 'try', 'wait', 'set']);
const TASK_DISCRIMINATORS = new Set([
  'call',
  'do',
  'fork',
  'emit',
  'for',
  'listen',
  'raise',
  'run',
  'set',
  'switch',
  'try',
  'wait',
]);
const TASK_LIST_FIELDS = new Set(['do', 'try', 'branches']);
const CALL_PROTOCOLS: Readonly<Record<string, readonly RequestMode[]>> = {
  http: ['http', 'graphql'],
  grpc: ['grpc'],
  mcp: ['mcp'],
  openapi: ['http', 'graphql'],
  asyncapi: ['websocket', 'sse', 'kafka', 'mqtt', 'socketio'],
};
const CALL_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  http: ['method', 'endpoint'],
  grpc: ['endpoint', 'service', 'method'],
  mcp: ['method', 'client'],
  openapi: [],
  asyncapi: [],
};

/**
 * Parses and validates an OWS document through the official SDK, then applies
 * Restura's fail-closed profile and local resource bindings. It intentionally
 * has no execution capability; runtime execution remains in the protocol
 * registry and agent policy layers.
 */
export function parseOwsSafeWorkflow(source: string, rawManifest: unknown): OwsSafeWorkflowResult {
  const parsedManifest = OwsBindingManifestSchema.safeParse(rawManifest);
  if (!parsedManifest.success) {
    return {
      ok: false,
      diagnostics: parsedManifest.error.issues.map((issue) => ({
        code: 'invalid-binding-manifest',
        path: formatPath(issue.path),
        message: issue.message,
      })),
    };
  }

  let workflow: OwsWorkflow;
  try {
    workflow = Classes.Workflow.deserialize(source).normalize();
    validate('Workflow', workflow);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'sdk-validation',
          path: sdkErrorPath(error),
          message: error instanceof Error ? error.message : 'The workflow is not valid OWS.',
        },
      ],
    };
  }

  const diagnostics = validateSafeProfile(workflow, parsedManifest.data);
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  return {
    ok: true,
    workflow: {
      workflow,
      graph: buildGraph(workflow),
      flatGraph: buildFlatGraph(workflow, true),
      manifest: parsedManifest.data,
      taskPaths: listTaskPaths(workflow),
    },
  };
}

/**
 * Serializes only through the native SDK so OWS output retains SDK
 * normalization. SDK alpha4's class-backed YAML output is broken upstream;
 * JSON is deliberately the only export until that upstream behaviour is fixed.
 */
export function serializeOwsWorkflow(workflow: OwsWorkflow): string {
  return Classes.Workflow.serialize(workflow, 'json');
}

function validateSafeProfile(
  workflow: OwsWorkflow,
  manifest: OwsBindingManifest
): OwsSafeProfileDiagnostic[] {
  const diagnostics: OwsSafeProfileDiagnostic[] = [];
  const workflowRecord = readRecord(workflow);
  const workflowDocument = readRecord(workflowRecord?.document);
  const workflowName = readString(workflowDocument, 'name');
  if (workflowName !== manifest.workflowId) {
    diagnostics.push({
      code: 'invalid-binding-manifest',
      path: 'workflowId',
      message: `Binding workflowId must match OWS document name ${workflowName ?? '(missing)'}.`,
    });
  }

  const tasksByPath = new Map(listTasks(workflow));
  for (const binding of manifest.bindings) {
    const target = tasksByPath.get(binding.taskPath);
    if (!target) {
      diagnostics.push({
        code: 'unknown-binding-task',
        path: binding.taskPath,
        message: `Binding does not reference an OWS task: ${binding.taskPath}.`,
      });
      continue;
    }

    const call = readString(target, 'call');
    if (call === undefined) {
      diagnostics.push({
        code: 'binding-target-not-call',
        path: binding.taskPath,
        message: 'Restura bindings can only target OWS call tasks.',
      });
      continue;
    }

    if (!CALL_PROTOCOLS[call]?.includes(binding.protocol)) {
      diagnostics.push({
        code: 'incompatible-binding',
        path: binding.taskPath,
        message: `OWS ${call} calls cannot bind to Restura ${binding.protocol} resources.`,
      });
    }
  }

  if (workflowRecord?.schedule !== undefined) {
    diagnostics.push({
      code: 'unsupported-declaration',
      path: 'schedule',
      message: 'OWS schedules are not supported by the Restura safe profile.',
    });
  }

  if (workflowRecord?.input !== undefined) {
    diagnostics.push({
      code: 'unsupported-declaration',
      path: 'input',
      message:
        'OWS workflow inputs are not supported until Restura has a secret-aware input resolver.',
    });
  }

  if (workflowRecord?.output !== undefined) {
    diagnostics.push({
      code: 'unsupported-declaration',
      path: 'output',
      message:
        'OWS workflow output is not supported until Restura has a secret-aware output resolver.',
    });
  }

  if (workflowDocument?.metadata !== undefined) {
    diagnostics.push({
      code: 'unsupported-declaration',
      path: 'document.metadata',
      message: 'OWS document metadata is not supported by the Restura safe profile.',
    });
  }

  const reusableComponents = readRecord(workflowRecord?.use);
  for (const declaration of [
    'authentications',
    'secrets',
    'functions',
    'extensions',
    'catalogs',
  ] as const) {
    if (reusableComponents?.[declaration] !== undefined) {
      diagnostics.push({
        code: 'unsupported-declaration',
        path: `use.${declaration}`,
        message: `OWS reusable ${declaration} are not supported by the Restura safe profile.`,
      });
    }
  }

  visitTasks(workflowRecord?.do, 'do', (task, path) => {
    collectEmbeddedCredentialDiagnostics(task, path, diagnostics);
    collectInlineCredentialDiagnostics(readRecord(task.with), `${path}.with`, diagnostics);
    const taskKinds = Object.keys(task).filter((key) => TASK_DISCRIMINATORS.has(key));
    if (task.metadata !== undefined) {
      diagnostics.push({
        code: 'unsupported-declaration',
        path: `${path}.metadata`,
        message: 'OWS task metadata is not supported by the Restura safe profile.',
      });
    }
    for (const field of ['input', 'output', 'export'] as const) {
      if (task[field] !== undefined) {
        diagnostics.push({
          code: 'unsupported-task-field',
          path: `${path}.${field}`,
          message: `OWS task ${field} is not supported until Restura has a secret-aware data resolver.`,
        });
      }
    }
    if (taskKinds.length === 0) {
      diagnostics.push({
        code: 'unsupported-task',
        path,
        message: 'OWS task does not declare a supported task discriminator.',
      });
    }
    for (const taskKind of taskKinds) {
      if (!ALLOWED_TASKS.has(taskKind)) {
        diagnostics.push({
          code: 'unsupported-task',
          path: `${path}.${taskKind}`,
          message: `OWS task ${taskKind} is not supported by the Restura safe profile.`,
        });
      }
    }

    const call = readString(task, 'call');
    if (call !== undefined) {
      const withArguments = readRecord(task.with);
      const allowedArguments = CALL_ARGUMENTS[call];
      if (withArguments && allowedArguments) {
        for (const key of Object.keys(withArguments)) {
          if (!allowedArguments.includes(key)) {
            diagnostics.push({
              code: 'unsupported-call-argument',
              path: `${path}.with.${key}`,
              message: `Inline OWS ${call} argument ${key} is not supported; use the bound Restura resource instead.`,
            });
          }
        }

        const endpoint = withArguments.endpoint;
        if (endpoint !== undefined) {
          const parsedEndpoint = typeof endpoint === 'string' ? parseHttpUrl(endpoint) : undefined;
          if (typeof endpoint !== 'string' || parsedEndpoint?.search) {
            diagnostics.push({
              code: 'unsupported-call-argument',
              path: `${path}.with.endpoint`,
              message:
                'OWS endpoints must be plain URLs without query parameters; use the bound Restura resource for request data.',
            });
          }
        }
      }
      if (!ALLOWED_CALLS.has(call)) {
        diagnostics.push({
          code: 'unsupported-task',
          path: `${path}.call`,
          message: `OWS call ${call} is not supported by the Restura safe profile.`,
        });
      } else if (!manifest.bindings.some((binding) => binding.taskPath === path)) {
        diagnostics.push({
          code: 'unbound-call',
          path,
          message: `OWS call ${path} requires a Restura binding.`,
        });
      }
    }
  });

  return diagnostics;
}

function listTaskPaths(workflow: OwsWorkflow): string[] {
  return listTasks(workflow).map(([path]) => path);
}

function listTasks(workflow: OwsWorkflow): Array<[string, Record<string, unknown>]> {
  const tasks: Array<[string, Record<string, unknown>]> = [];
  visitTasks(readRecord(workflow)?.do, 'do', (task, path) => tasks.push([path, task]));
  return tasks;
}

function visitTasks(
  taskList: unknown,
  basePath: string,
  visit: (task: Record<string, unknown>, path: string) => void
): void {
  if (!Array.isArray(taskList)) return;

  for (const [index, item] of taskList.entries()) {
    const taskItem = readRecord(item);
    if (!taskItem) continue;
    for (const [name, rawTask] of Object.entries(taskItem)) {
      const task = readRecord(rawTask);
      if (!task) continue;
      const path = `${basePath}[${index}].${name}`;
      visit(task, path);
      visitNestedTaskLists(task, path, visit);
    }
  }
}

function visitNestedTaskLists(
  value: Record<string, unknown>,
  path: string,
  visit: (task: Record<string, unknown>, path: string) => void
): void {
  for (const [key, child] of Object.entries(value)) {
    if (TASK_LIST_FIELDS.has(key)) {
      visitTasks(child, `${path}.${key}`, visit);
    } else if (isRecord(child)) {
      visitNestedTaskLists(child, `${path}.${key}`, visit);
    } else if (Array.isArray(child)) {
      for (const [index, item] of child.entries()) {
        if (isRecord(item)) visitNestedTaskLists(item, `${path}.${key}[${index}]`, visit);
      }
    }
  }
}

function collectEmbeddedCredentialDiagnostics(
  value: unknown,
  path: string,
  diagnostics: OwsSafeProfileDiagnostic[]
): void {
  if (typeof value === 'string') {
    const parsed = parseHttpUrl(value);
    if (parsed?.username || parsed?.password) {
      diagnostics.push({
        code: 'embedded-credential',
        path,
        message:
          'Credentialed URLs are not allowed in OWS documents; use a Restura secret handle at execution time.',
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectEmbeddedCredentialDiagnostics(item, `${path}[${index}]`, diagnostics);
    }
    return;
  }

  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      collectEmbeddedCredentialDiagnostics(child, `${path}.${key}`, diagnostics);
    }
  }
}

function collectInlineCredentialDiagnostics(
  value: Record<string, unknown> | undefined,
  path: string,
  diagnostics: OwsSafeProfileDiagnostic[]
): void {
  if (!value) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (
      ['authentication', 'authorization', 'proxy-authorization', 'x-api-key', 'api-key'].includes(
        key.toLowerCase()
      )
    ) {
      diagnostics.push({
        code: 'inline-credential',
        path: childPath,
        message:
          'Inline call authentication is not allowed; bind a Restura resource with secret handles instead.',
      });
      continue;
    }
    if (isRecord(child)) collectInlineCredentialDiagnostics(child, childPath, diagnostics);
    if (Array.isArray(child)) {
      for (const [index, item] of child.entries()) {
        if (isRecord(item))
          collectInlineCredentialDiagnostics(item, `${childPath}[${index}]`, diagnostics);
      }
    }
  }
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function formatPath(path: PropertyKey[]): string {
  return path.map(String).join('.') || 'manifest';
}

function sdkErrorPath(error: unknown): string {
  if (isRecord(error) && typeof error.path === 'string') return error.path || 'workflow';
  return 'workflow';
}
