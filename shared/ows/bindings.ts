import type { OwsWorkflow } from './workflow-profile';

/**
 * Restura-owned, non-executable references attached to an OWS document.
 * Credentials, environment values, and transport configuration are resolved
 * only by the platform-owned resource stores at execution time.
 */
/**
 * `resourceId` is a stable saved-resource reference. File workspaces use the
 * percent-encoded slash-joined OpenCollection logical path (for example
 * `Users/Get%20user`),
 * while in-app collections may resolve a current opaque id. A binding never
 * contains the request's endpoint, headers, authentication, or credentials.
 */
export type OwsTaskBinding =
  | { kind: 'saved-request'; call: 'http'; resourceId: string }
  | { kind: 'saved-request'; call: 'http'; protocol: 'graphql'; resourceId: string };

export interface OwsBindings {
  version: 1;
  tasks: Record<string, OwsTaskBinding>;
}

export interface OwsLayout {
  version: 1;
  nodes: Record<string, { x: number; y: number }>;
  viewport?: { x: number; y: number; zoom: number };
}

export interface OwsBindingIssue {
  path: string;
  message: string;
  severity: 'error';
}

export type OwsBindingsValidation =
  | { ok: true; issues: [] }
  | { ok: false; issues: OwsBindingIssue[] };

export const OWS_RESOURCE_ID_PATTERN =
  '^(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9][A-Za-z0-9._:%-]*(?:/[A-Za-z0-9][A-Za-z0-9._:%-]*){0,15}$';
export const OWS_TASK_PATH_PATTERN =
  '^/do(?:/\\d+/[A-Za-z0-9][A-Za-z0-9._-]*)+(?:/(?:do|try|catch/do)/\\d+/[A-Za-z0-9][A-Za-z0-9._-]*)*$';
const RESOURCE_ID = new RegExp(OWS_RESOURCE_ID_PATTERN);
const TASK_PATH = new RegExp(OWS_TASK_PATH_PATTERN);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function bindingIssue(path: string, message: string): OwsBindingIssue {
  return { path, message, severity: 'error' };
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

export function isOwsTaskBinding(value: unknown): value is OwsTaskBinding {
  if (!isPlainRecord(value)) return false;
  const isHttp = hasExactKeys(value, ['kind', 'call', 'resourceId']);
  const isGraphql = hasExactKeys(value, ['kind', 'call', 'protocol', 'resourceId']);
  if (!isHttp && !isGraphql) return false;
  return (
    value.kind === 'saved-request' &&
    value.call === 'http' &&
    (isHttp || value.protocol === 'graphql') &&
    typeof value.resourceId === 'string' &&
    value.resourceId === value.resourceId.trim() &&
    RESOURCE_ID.test(value.resourceId)
  );
}

export function validateOwsBindings(value: unknown): OwsBindingsValidation {
  const issues: OwsBindingIssue[] = [];
  if (!isPlainRecord(value)) {
    return { ok: false, issues: [bindingIssue('/', 'Workflow bindings must be an object.')] };
  }
  for (const key of Object.keys(value)) {
    if (key !== 'version' && key !== 'tasks') {
      issues.push(
        bindingIssue(
          `/${escapePointerSegment(key)}`,
          'Workflow bindings contain an unsupported field.'
        )
      );
    }
  }
  if (value.version !== 1) {
    issues.push(bindingIssue('/version', 'Workflow bindings must use version 1.'));
  }
  if (!isPlainRecord(value.tasks)) {
    issues.push(bindingIssue('/tasks', 'Workflow bindings tasks must be an object.'));
  } else {
    for (const [taskPath, binding] of Object.entries(value.tasks)) {
      const path = `/tasks/${escapePointerSegment(taskPath)}`;
      if (!TASK_PATH.test(taskPath)) {
        issues.push(
          bindingIssue(path, 'Workflow binding task paths must reference a portable OWS task.')
        );
      }
      if (!isOwsTaskBinding(binding)) {
        issues.push(
          bindingIssue(
            path,
            'Workflow bindings may contain only typed saved-request references without transport material.'
          )
        );
      }
    }
  }
  return issues.length === 0 ? { ok: true, issues: [] } : { ok: false, issues };
}

export function isOwsBindings(value: unknown): value is OwsBindings {
  return validateOwsBindings(value).ok;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Return only executable saved-request call paths; a binding for any other task is stale. */
export function collectOwsCallPaths(workflow: OwsWorkflow): Set<string> {
  const paths = new Set<string>();
  const visit = (list: unknown, parentPath: string): void => {
    if (!Array.isArray(list)) return;
    for (const [index, entry] of list.entries()) {
      if (!isRecord(entry) || Object.keys(entry).length !== 1) continue;
      const [name, task] = Object.entries(entry)[0] ?? [];
      if (!name || !isRecord(task)) continue;
      const taskPath = `${parentPath}/${index}/${name}`;
      if (task.call === 'http') paths.add(taskPath);
      if ('do' in task) visit(task.do, `${taskPath}/do`);
      if ('try' in task) visit(task.try, `${taskPath}/try`);
      if (isRecord(task.catch) && 'do' in task.catch) {
        visit(task.catch.do, `${taskPath}/catch/do`);
      }
    }
  };
  visit(workflow.do, '/do');
  return paths;
}

/**
 * Structured artifact validation shared by live editor diagnostics and the
 * persistence/execution boundaries. It never normalizes or repairs drafts.
 */
export function validateOwsArtifactBindings(
  workflow: OwsWorkflow,
  bindings: unknown
): OwsBindingsValidation {
  const bindingsValidation = validateOwsBindings(bindings);
  if (!bindingsValidation.ok) return bindingsValidation;
  const typedBindings = bindings as OwsBindings;

  const callPaths = collectOwsCallPaths(workflow);
  const issues: OwsBindingIssue[] = [];
  for (const taskPath of callPaths) {
    if (!typedBindings.tasks[taskPath]) {
      issues.push(
        bindingIssue('/tasks', `Workflow call ${taskPath} is missing an approved binding.`)
      );
    }
  }
  for (const taskPath of Object.keys(typedBindings.tasks)) {
    if (!callPaths.has(taskPath)) {
      issues.push(
        bindingIssue(
          `/tasks/${escapePointerSegment(taskPath)}`,
          `Workflow binding task path ${taskPath} does not exist in the workflow document.`
        )
      );
    }
  }
  return issues.length === 0 ? { ok: true, issues: [] } : { ok: false, issues };
}
