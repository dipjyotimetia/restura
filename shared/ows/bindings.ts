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

const RESOURCE_ID =
  /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9][A-Za-z0-9._:%-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:%-]*){0,15}$/;
const TASK_PATH =
  /^\/do(?:\/\d+\/[A-Za-z0-9][A-Za-z0-9._-]*)+(?:\/(?:do|try|catch\/do)\/\d+\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

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

export function isOwsBindings(value: unknown): value is OwsBindings {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['version', 'tasks'])) return false;
  if (value.version !== 1 || !isPlainRecord(value.tasks)) return false;

  return Object.entries(value.tasks).every(
    ([taskPath, binding]) => TASK_PATH.test(taskPath) && isOwsTaskBinding(binding)
  );
}
