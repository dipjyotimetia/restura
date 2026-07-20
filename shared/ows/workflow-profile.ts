import type { Specification } from '@openworkflowspec/sdk';
import * as yaml from 'js-yaml';

/** The sole workflow DSL Restura reads or writes. */
export const RESTURA_OWS_DSL_VERSION = '1.0.3' as const;
/** Largest delay that browsers and Node can enforce without timer clamping. */
export const MAX_OWS_DURATION_MS = 2_147_483_647;

export type OwsWorkflow = Specification.Workflow;

export interface OwsProfileIssue {
  path: string;
  message: string;
  severity: 'error';
}

export type OwsProfileValidation =
  | { ok: true; issues: [] }
  | { ok: false; issues: OwsProfileIssue[] };

const TASK_DISCRIMINATORS = [
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
] as const;
const SAFE_TASKS = new Set(['do', 'set', 'wait']);
const SAFE_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const DURATION_FIELDS = new Set(['days', 'hours', 'minutes', 'seconds', 'milliseconds']);
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const DOCUMENT_FIELDS = new Set([
  'dsl',
  'namespace',
  'name',
  'version',
  'title',
  'summary',
  'tags',
  'metadata',
]);
const WORKFLOW_IDENTIFIER = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function profileError(path: string, message: string): OwsProfileIssue {
  return { path, message, severity: 'error' };
}

function validateDuration(value: unknown, path: string, issues: OwsProfileIssue[]): void {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    issues.push(profileError(path, 'Restura accepts only inline, finite OWS durations.'));
    return;
  }

  let totalMs = 0;
  for (const [key, amount] of Object.entries(value)) {
    if (
      !DURATION_FIELDS.has(key) ||
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      amount < 0
    ) {
      issues.push(
        profileError(path, 'Restura accepts only non-negative finite OWS duration fields.')
      );
      return;
    }
    const multiplier =
      key === 'days'
        ? 86_400_000
        : key === 'hours'
          ? 3_600_000
          : key === 'minutes'
            ? 60_000
            : key === 'seconds'
              ? 1000
              : 1;
    totalMs += amount * multiplier;
  }
  if (!Number.isFinite(totalMs) || totalMs > MAX_OWS_DURATION_MS) {
    issues.push(
      profileError(
        path,
        `OWS durations may not exceed ${MAX_OWS_DURATION_MS} milliseconds, the maximum safe platform timer.`
      )
    );
  }
}

/**
 * Small, CSP-safe validation for the SDK schema subset that can reach the
 * renderer. Keep this structural gate deliberately fail-closed: the Node
 * workspace uses the SDK for the complete OWS model, while web and in-memory
 * desktop workflows must never persist or execute data outside this profile.
 */
function validateDocument(value: unknown, issues: OwsProfileIssue[]): void {
  if (!isRecord(value)) {
    issues.push(profileError('/document', 'OWS document metadata must be an object.'));
    return;
  }

  for (const key of Object.keys(value)) {
    if (!DOCUMENT_FIELDS.has(key)) {
      issues.push(profileError(`/document/${key}`, 'OWS document metadata is not supported.'));
    }
  }

  if (value.dsl !== RESTURA_OWS_DSL_VERSION) {
    issues.push(
      profileError('/document/dsl', `Restura supports only OWS DSL ${RESTURA_OWS_DSL_VERSION}.`)
    );
  }
  for (const field of ['namespace', 'name'] as const) {
    if (typeof value[field] !== 'string' || !WORKFLOW_IDENTIFIER.test(value[field])) {
      issues.push(
        profileError(
          `/document/${field}`,
          'OWS workflow namespace and name must be portable identifiers.'
        )
      );
    }
  }
  if (typeof value.version !== 'string' || !SEMVER.test(value.version)) {
    issues.push(
      profileError('/document/version', 'OWS workflow version must be semantic version.')
    );
  }
  for (const field of ['title', 'summary'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      issues.push(profileError(`/document/${field}`, `OWS document ${field} must be a string.`));
    }
  }
  for (const field of ['tags', 'metadata'] as const) {
    if (value[field] !== undefined) validateSet(value[field], `/document/${field}`, issues);
  }
}

function validateTimeout(value: unknown, path: string, issues: OwsProfileIssue[]): void {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !('after' in value)) {
    issues.push(
      profileError(path, 'Restura accepts only an inline OWS timeout with an after duration.')
    );
    return;
  }
  validateDuration(value.after, `${path}/after`, issues);
}

function validateSetValue(value: unknown, path: string, issues: OwsProfileIssue[]): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      issues.push(profileError(path, 'OWS set values must be finite JSON values.'));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateSetValue(item, `${path}/${index}`, issues));
    return;
  }
  if (!isRecord(value)) {
    issues.push(
      profileError(path, 'OWS set values must be JSON data or simple runtime references.')
    );
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      issues.push(
        profileError(`${path}/${key}`, 'OWS set values may not modify object prototypes.')
      );
      continue;
    }
    validateSetValue(item, `${path}/${key}`, issues);
  }
}

function validateSet(value: unknown, path: string, issues: OwsProfileIssue[]): void {
  if (!isRecord(value)) {
    issues.push(profileError(path, "OWS 'set' must assign an object."));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      issues.push(
        profileError(`${path}/${key}`, 'OWS set tasks may not modify object prototypes.')
      );
      continue;
    }
    validateSetValue(item, `${path}/${key}`, issues);
  }
}

function validateBoundHttpCall(
  task: Record<string, unknown>,
  path: string,
  issues: OwsProfileIssue[]
): void {
  if (task.call !== 'http') {
    issues.push(
      profileError(
        path,
        'Restura supports only binding-only HTTP calls in the current OWS profile.'
      )
    );
    return;
  }
  if (!isRecord(task.with) || Object.keys(task.with).length !== 2) {
    issues.push(
      profileError(
        `${path}/with`,
        'OWS HTTP calls must contain only method and the Restura binding endpoint.'
      )
    );
    return;
  }
  const method = task.with.method;
  if (typeof method !== 'string' || !SAFE_HTTP_METHODS.has(method)) {
    issues.push(
      profileError(
        `${path}/with/method`,
        'OWS binding-only HTTP calls must use a supported HTTP method.'
      )
    );
  }
  const endpoint = task.with.endpoint;
  if (
    !isRecord(endpoint) ||
    Object.keys(endpoint).length !== 1 ||
    endpoint.uri !== 'restura://saved-request'
  ) {
    issues.push(
      profileError(
        `${path}/with/endpoint`,
        'OWS HTTP calls must use the restura://saved-request binding endpoint.'
      )
    );
  }
}

function validateTaskList(list: unknown, path: string, issues: OwsProfileIssue[]): void {
  if (!Array.isArray(list) || list.length === 0) {
    issues.push(profileError(path, 'OWS task list must be an array.'));
    return;
  }

  const taskNames = new Set<string>();
  for (const [index, entry] of list.entries()) {
    const entryPath = `${path}/${index}`;
    if (!isRecord(entry) || Object.keys(entry).length !== 1) {
      issues.push(profileError(entryPath, 'Each OWS task must have exactly one task name.'));
      continue;
    }
    const [name, task] = Object.entries(entry)[0] ?? [];
    const taskPath = `${entryPath}/${name}`;
    if (name && taskNames.has(name)) {
      issues.push(
        profileError(entryPath, `OWS task name '${name}' must be unique within its list.`)
      );
    }
    if (name) taskNames.add(name);
    if (!isRecord(task)) {
      issues.push(profileError(taskPath, 'OWS task must be an object.'));
      continue;
    }

    const active = TASK_DISCRIMINATORS.filter((key) => task[key] !== undefined);
    if (active.length !== 1) {
      issues.push(
        profileError(taskPath, 'Restura tasks must contain exactly one supported task operation.')
      );
      continue;
    }
    const operation = active[0];
    if (!operation) continue;
    if (!SAFE_TASKS.has(operation) && operation !== 'call') {
      const message = `OWS '${operation}' tasks are not implemented by Restura's safe executor.`;
      issues.push(profileError(taskPath, message));
    }

    for (const key of Object.keys(task)) {
      if (key !== operation && key !== 'timeout' && !(operation === 'call' && key === 'with')) {
        issues.push(
          profileError(
            `${taskPath}/${key}`,
            `OWS task-level '${key}' is unavailable until Restura can enforce it safely.`
          )
        );
      }
    }
    if (task.timeout !== undefined) validateTimeout(task.timeout, `${taskPath}/timeout`, issues);

    if (operation === 'do') validateTaskList(task.do, `${taskPath}/do`, issues);
    if (operation === 'set') validateSet(task.set, `${taskPath}/set`, issues);
    if (operation === 'wait') validateDuration(task.wait, `${taskPath}/wait`, issues);
    if (operation === 'call') validateBoundHttpCall(task, taskPath, issues);
  }
}

/**
 * OWS' schema deliberately supports automation features Restura cannot safely
 * host. This product-owned validation layer is intentionally narrower than
 * the SDK: it enables only controls the executor enforces today.
 */
export function validateOwsProfile(workflow: OwsWorkflow): OwsProfileValidation {
  const issues: OwsProfileIssue[] = [];
  const candidate = workflow as Record<string, unknown>;

  for (const key of Object.keys(candidate)) {
    if (key !== 'document' && key !== 'do' && key !== 'timeout') {
      const message =
        key === 'schedule'
          ? 'Schedules and event triggers are not executable in Restura.'
          : `OWS workflow-level '${key}' is unavailable until Restura can enforce it safely.`;
      issues.push(profileError(`/${key}`, message));
    }
  }
  validateDocument(candidate.document, issues);
  if (candidate.timeout !== undefined) validateTimeout(candidate.timeout, '/timeout', issues);
  validateTaskList(candidate.do, '/do', issues);

  return issues.length === 0 ? { ok: true, issues: [] } : { ok: false, issues };
}

/** Parse OWS JSON only. YAML is intentionally import-only until the upstream SDK has stable JSON/YAML parity. */
function assertSafeOwsDocument(value: unknown): OwsWorkflow {
  if (!isRecord(value) || !isRecord(value.document) || !Array.isArray(value.do)) {
    throw new Error('Expected an OWS workflow document.');
  }
  const workflow = JSON.parse(JSON.stringify(value)) as OwsWorkflow;
  const profile = validateOwsProfile(workflow);
  if (!profile.ok) {
    throw new Error(
      `OWS workflow is outside Restura's executable profile: ${profile.issues[0]?.message}`
    );
  }
  return workflow;
}

/**
 * CSP-safe renderer parser. The desktop renderer cannot load Ajv's runtime
 * code generator under its strict CSP; the Electron/CLI workspace boundary
 * performs the full SDK parse/normalize/validate before filesystem execution.
 */
export function parseOwsWorkflowJson(source: string): OwsWorkflow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('OWS workflows must be JSON.');
  }
  return assertSafeOwsDocument(parsed);
}

/**
 * Import an OWS document supplied as JSON or YAML. Persisted workflow files
 * remain JSON-only: the Node workspace and CLI boundaries serialize with the SDK.
 */
export function parseOwsWorkflowImport(source: string): OwsWorkflow {
  try {
    return assertSafeOwsDocument(
      source.trimStart().startsWith('{') ? JSON.parse(source) : yaml.load(source)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid OWS workflow import: ${message}`);
  }
}

/** Normalize renderer data without invoking CSP-incompatible dynamic code generation. */
export function normalizeOwsWorkflow(workflow: OwsWorkflow): OwsWorkflow {
  return assertSafeOwsDocument(workflow);
}

/** Deterministic OWS JSON is the only portable Flow executable artifact. */
export function serializeOwsWorkflowJson(workflow: OwsWorkflow): string {
  return `${JSON.stringify(sortJson(normalizeOwsWorkflow(workflow)), null, 2)}\n`;
}

/** Sort object keys without changing task-list order, yielding Git-stable JSON in the renderer. */
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])])
  );
}

export interface OwsGraphProjection {
  entryNode?: { id: string };
  nodes: Array<{ id: string }>;
}

/** CSP-safe visual projection; synthetic visual nodes are never persisted. */
export function buildOwsGraph(workflow: OwsWorkflow): OwsGraphProjection {
  const nodes: Array<{ id: string }> = [];
  const visit = (list: unknown, path: string): void => {
    if (!Array.isArray(list)) return;
    for (const [index, entry] of list.entries()) {
      if (!isRecord(entry) || Object.keys(entry).length !== 1) continue;
      const [name, task] = Object.entries(entry)[0] ?? [];
      if (!name || !isRecord(task)) continue;
      const id = `${path}/${index}/${name}`;
      nodes.push({ id });
      if ('do' in task) visit(task.do, `${id}/do`);
    }
  };
  visit(normalizeOwsWorkflow(workflow).do, '/do');
  return { ...(nodes[0] ? { entryNode: nodes[0] } : {}), nodes };
}
