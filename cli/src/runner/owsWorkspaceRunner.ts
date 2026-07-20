import { executeOwsWorkflow, type OwsExecutionResult } from '@shared/ows/executor';
import type { HttpRequest } from '@shared/types';
import { type LoadedCollection, type LoadedRequest, loadCollection } from './collectionLoader';
import { executeHttp } from './executors/http';
import type { ExecuteOptions, ExecuteOutcome } from './executors/types';
import { discoverOwsWorkspace } from './owsWorkspaceLoader';

export type OwsWorkspaceRunOptions = Omit<ExecuteOptions, 'vars'> & {
  /** Values available to OWS set tasks and saved HTTP request variables. */
  variables: Record<string, string>;
};

export interface OwsWorkspaceRunnerDependencies {
  loadCollection(path: string): Promise<LoadedCollection>;
  executeHttp(item: LoadedRequest, options: ExecuteOptions): Promise<ExecuteOutcome>;
}

const defaultDependencies: OwsWorkspaceRunnerDependencies = { loadCollection, executeHttp };

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
  method: string
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
  if ((item.request as HttpRequest).method !== method) {
    throw new Error(
      `OWS binding ${resourceId} method does not match its saved HTTP request (${method}).`
    );
  }
  return item;
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
  return executeOwsWorkflow({
    workflow: selected.artifact.workflow,
    bindings: selected.artifact.bindings,
    variables: options.variables,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    dispatcher: {
      async dispatch(call): Promise<ExecuteOutcome> {
        const item = resolveBoundHttpRequest(collection, call.binding.resourceId, call.method);
        const outcome = await dependencies.executeHttp(item, {
          vars: options.variables,
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
        return outcome;
      },
    },
  });
}
