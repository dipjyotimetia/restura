import type { OwsTaskBinding } from '@shared/ows/bindings';
import { executeOwsWorkflow, type OwsExecutionResult } from '@shared/ows/executor';
import { getGraphqlOperation, getGraphqlResponseErrors } from '@shared/ows/graphql-operation';
import type { HttpRequest } from '@shared/types';
import { type LoadedCollection, type LoadedRequest, loadCollection } from './collectionLoader';
import { executeHttp } from './executors/http';
import type { ExecuteOptions, ExecuteOutcome } from './executors/types';
import { discoverOwsWorkspace } from './owsWorkspaceLoader';

export type OwsWorkspaceRunOptions = Omit<ExecuteOptions, 'vars'> & {
  /** Values available to OWS set tasks and saved HTTP request variables. */
  variables: Record<string, string>;
  /** Explicit non-interactive approval for saved GraphQL mutation calls. */
  allowMutations?: boolean;
};

export interface OwsWorkspaceRunnerDependencies {
  loadCollection(path: string): Promise<LoadedCollection>;
  executeHttp(item: LoadedRequest, options: ExecuteOptions): Promise<ExecuteOutcome>;
}

const defaultDependencies: OwsWorkspaceRunnerDependencies = { loadCollection, executeHttp };

type GraphqlBinding = Extract<OwsTaskBinding, { protocol: 'graphql' }>;

function isGraphqlBinding(binding: OwsTaskBinding | undefined): binding is GraphqlBinding {
  return binding !== undefined && 'protocol' in binding && binding.protocol === 'graphql';
}

function stringVariables(values: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? [[key, String(value)]]
        : []
    )
  );
}

/** Convert the OpenCollection logical path into the portable binding reference form. */
export function toOwsResourceId(relativePath: string): string {
  return relativePath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function resolveBoundHttpRequest(
  collection: LoadedCollection,
  resourceId: string,
  method: string,
  binding?: OwsTaskBinding
): LoadedRequest {
  // `relativePath` is the canonical logical OpenCollection request path. It
  // is portable across machines and intentionally goes stale on a rename,
  // rather than silently binding an OWS call to a different saved request.
  const matches = collection.requests.filter(
    (candidate) => toOwsResourceId(candidate.relativePath) === resourceId
  );
  if (matches.length === 0) {
    throw new Error(`OWS binding ${resourceId} does not resolve to a saved request.`);
  }
  if (matches.length > 1) {
    throw new Error(`OWS binding ${resourceId} resolves to multiple saved requests.`);
  }
  const item = matches[0]!;
  if (item.type !== 'http') {
    throw new Error(`OWS binding ${resourceId} is not an HTTP request.`);
  }
  const request = item.request as HttpRequest;
  if (request.method !== method) {
    throw new Error(
      `OWS binding ${resourceId} method does not match its saved HTTP request (${method}).`
    );
  }
  if (isGraphqlBinding(binding)) {
    if (request.method !== 'POST' || request.body.type !== 'graphql') {
      throw new Error(
        `OWS GraphQL binding ${resourceId} does not resolve to a saved GraphQL POST request.`
      );
    }
  } else if (request.body.type === 'graphql') {
    throw new Error(`OWS HTTP binding ${resourceId} cannot resolve to a saved GraphQL request.`);
  }
  return item;
}

function collectCalls(
  list: unknown,
  path: string,
  calls: Array<{ path: string; method: string }>
): void {
  if (!Array.isArray(list)) return;
  for (const [index, entry] of list.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const named = Object.entries(entry as Record<string, unknown>)[0];
    if (!named) continue;
    const [name, task] = named;
    if (!task || typeof task !== 'object' || Array.isArray(task)) continue;
    const value = task as Record<string, unknown>;
    const taskPath = `${path}/${index}/${name}`;
    if (
      value.call === 'http' &&
      value.with &&
      typeof value.with === 'object' &&
      typeof (value.with as { method?: unknown }).method === 'string'
    ) {
      calls.push({ path: taskPath, method: (value.with as { method: string }).method });
    }
    if ('do' in value) collectCalls(value.do, `${taskPath}/do`, calls);
    if ('try' in value) collectCalls(value.try, `${taskPath}/try`, calls);
    if (value.catch && typeof value.catch === 'object' && 'do' in value.catch) {
      collectCalls((value.catch as { do?: unknown }).do, `${taskPath}/catch/do`, calls);
    }
  }
}

/**
 * Execute the narrow OWS profile supported by the CLI.
 *
 * Only binding-only HTTP calls are allowed. Each binding resolves by its
 * canonical OpenCollection logical request path, then is delegated to the
 * existing CLI HTTP executor so URL validation, header policy, auth handling,
 * timeout, and cancellation remain in the established security path.
 */
export async function runOwsWorkspaceWorkflow(
  root: string,
  id: string,
  options: OwsWorkspaceRunOptions,
  dependencies: OwsWorkspaceRunnerDependencies = defaultDependencies
): Promise<OwsExecutionResult> {
  const workspace = await discoverOwsWorkspace(root);
  const selected = workspace.workflows.find((workflow) => workflow.id === id);
  if (!selected) throw new Error(`OWS workflow was not found in workspace: ${id}`);

  // Loading the full directory validates the OpenCollection request set before
  // any binding is resolved. `discoverOwsWorkspace` has already checked the
  // root marker and every workflow companion artifact.
  const collection = await dependencies.loadCollection(workspace.root);
  const calls: Array<{ path: string; method: string }> = [];
  collectCalls(selected.artifact.workflow.do, '/do', calls);
  for (const call of calls) {
    const binding = selected.artifact.bindings.tasks[call.path];
    if (!isGraphqlBinding(binding)) continue;
    const item = resolveBoundHttpRequest(collection, binding.resourceId, call.method, binding);
    const operation = getGraphqlOperation(item.request as HttpRequest);
    if (operation.kind === 'mutation' && !options.allowMutations) {
      throw new Error(
        `Workflow contains GraphQL mutation '${operation.name ?? binding.resourceId}'; pass --allow-mutations to run it.`
      );
    }
  }
  return executeOwsWorkflow({
    workflow: selected.artifact.workflow,
    bindings: selected.artifact.bindings,
    variables: options.variables,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    dispatcher: {
      async dispatch(call): Promise<ExecuteOutcome> {
        const item = resolveBoundHttpRequest(
          collection,
          call.binding.resourceId,
          call.method,
          call.binding
        );
        const outcome = await dependencies.executeHttp(item, {
          vars: stringVariables(call.variables),
          timeoutMs: call.timeoutMs ?? options.timeoutMs,
          allowLocalhost: options.allowLocalhost,
          signal: call.signal,
          ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
          ...(options.oauthFetch ? { oauthFetch: options.oauthFetch } : {}),
        });
        if (!outcome.passed) {
          throw new Error(
            outcome.errorMessage ??
              `Saved HTTP request ${call.binding.resourceId} returned unsuccessful status ${outcome.status}.`
          );
        }
        if (isGraphqlBinding(call.binding)) {
          const errors = getGraphqlResponseErrors(outcome.responseBody);
          if (errors.length > 0) {
            throw new Error(
              `Saved GraphQL request ${call.binding.resourceId} returned errors: ${errors.join('; ')}`
            );
          }
        }
        return outcome;
      },
    },
  });
}
