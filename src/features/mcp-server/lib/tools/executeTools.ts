/**
 * Execute tier tools. Sends go through the collection runner — the same
 * pipeline the Runner dialog uses (protocol registry → real executors: SSRF
 * guard, wire-level auth signing, inherited folder/collection auth, scripts,
 * tests, desktop transport hardening). There is no second request path for
 * agents. Each send is recorded in the Runs panel.
 */

import {
  canExecute,
  canExecuteWithEnvironment,
  canReadEnvironment,
} from '@shared/mcp-server/consent';
import type { ControlToolInput } from '@shared/mcp-server/control-tools';
import { redactBodyForAgent, redactHeadersForAgent } from '@shared/mcp-server/redaction';
import { resolveRunVariables } from '@/features/collections/hooks/useCollectionRun';
import {
  type CollectionRunResult,
  type RequestCompleteInfo,
  runCollection,
} from '@/features/collections/lib/collectionRunner';
import { flattenRunnables } from '@/features/collections/lib/flattenRunnables';
import { useCollectionRunStore } from '@/store/useCollectionRunStore';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import type { Response as ApiResponse, Collection, Environment } from '@/types';
import { locateItem } from '../tree';
import { refuse, SETTINGS_HINT, type ToolEnv, type ToolImpl, type ToolRefusal } from './types';

/** Default response body characters returned to the agent. */
export const DEFAULT_MAX_BODY_CHARS = 20_000;

function sendableCollection(collectionId: string, env: ToolEnv): Collection | ToolRefusal {
  const collection = useCollectionStore.getState().getCollectionById(collectionId);
  if (!collection || !canExecute(env.settings.consent, collection.id)) {
    return refuse(
      `Sending requests in this collection is not allowed (it needs “Full” access). ${SETTINGS_HINT}`
    );
  }
  return collection;
}

function sendEnvironment(
  environmentId: string | undefined,
  collection: Collection,
  env: ToolEnv
): Environment | null | ToolRefusal {
  if (environmentId === undefined) return null;
  const environment = useEnvironmentStore
    .getState()
    .environments.find((e) => e.id === environmentId);
  if (
    !environment ||
    !canReadEnvironment(env.settings.consent, environment.id) ||
    !canExecuteWithEnvironment(env.settings.consent, environment.id)
  ) {
    return refuse(
      `Sending with this environment is not allowed. The user must tick “Agents may send with this environment”. ${SETTINGS_HINT}`
    );
  }
  if (environment.collectionId !== undefined && environment.collectionId !== collection.id) {
    return refuse('That environment belongs to a different collection.');
  }
  return environment;
}

function rootsOf(collection: Collection) {
  return {
    preRequestScript: collection.preRequestScript,
    testScript: collection.testScript,
  };
}

function agentResponse(response: ApiResponse, env: ToolEnv, maxBodyChars: number) {
  const binary = response.bodyEncoding === 'base64';
  const body = binary
    ? { text: '', originalLength: response.body.length, truncated: false, redactions: 0 }
    : redactBodyForAgent(response.body, {
        redact: env.settings.redactResponseBodies,
        maxChars: maxBodyChars,
      });
  return {
    status: response.status,
    statusText: response.statusText,
    timeMs: response.time,
    sizeBytes: response.size,
    // Everything from the remote server is third-party data.
    untrustedContent: {
      headers: env.settings.redactResponseBodies
        ? redactHeadersForAgent(response.headers)
        : Object.fromEntries(
            Object.entries(response.headers).map(([k, v]) => [
              k,
              Array.isArray(v) ? v.join(', ') : v,
            ])
          ),
      ...(binary ? { binaryBody: true } : { body: body.text }),
    },
    bodyChars: body.originalLength,
    bodyTruncated: body.truncated,
    redactedValues: body.redactions,
  };
}

function runSummary(run: CollectionRunResult) {
  return {
    runId: run.id,
    outcome: run.outcome,
    durationMs: run.durationMs,
    summary: run.summary,
    requests: run.requests.slice(0, 200).map((r) => ({
      requestId: r.itemId,
      name: r.itemName,
      iteration: r.iteration,
      status: r.status,
      ...(r.httpStatus !== undefined ? { httpStatus: r.httpStatus } : {}),
      ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(r.skippedReason ? { skippedReason: r.skippedReason } : {}),
      assertions: r.assertions.map((a) => ({
        name: a.name,
        passed: a.passed,
        ...(a.error ? { error: a.error } : {}),
      })),
    })),
  };
}

async function runScope(options: {
  collection: Collection;
  environment: Environment | null;
  folderId?: string;
  onlyItemId?: string;
  iterations: number;
  stopOnFailure: boolean;
  scopeName: string;
  signal: AbortSignal;
  onRequestComplete?: (info: RequestCompleteInfo) => void;
}): Promise<CollectionRunResult> {
  const { collection, environment } = options;
  let runnables = flattenRunnables(
    collection.items,
    options.folderId,
    rootsOf(collection),
    collection.auth,
    collection
  );
  if (options.onlyItemId) runnables = runnables.filter((r) => r.itemId === options.onlyItemId);
  if (runnables.length === 0) throw new Error('Nothing to run: no runnable requests in scope.');

  const vars = resolveRunVariables(environment?.id ?? 'none', collection);
  const run = await runCollection(
    {
      collection,
      scopeName: options.scopeName,
      runnables,
      baseVars: vars.baseVars,
      globalVars: vars.globalVars,
      environmentVars: vars.environmentVars,
      secretNames: vars.secretNames,
      iterations: options.iterations,
      dataRows: [],
      delayMs: 0,
      stopOnFailure: options.stopOnFailure,
      retention: 'metadata',
      ...(environment ? { environmentId: environment.id, environmentName: environment.name } : {}),
    },
    () => undefined,
    options.signal,
    options.onRequestComplete
  );
  // Visible to the user in the Runs panel, like any other run.
  useCollectionRunStore.getState().addRun(run);
  return run;
}

const sendRequest: ToolImpl<ControlToolInput<'send_request'>> = (input, env) => {
  const located = locateItem(useCollectionStore.getState().collections, input.requestId);
  if (!located) return refuse(`Request not found: ${input.requestId}`);
  const collection = sendableCollection(located.collection.id, env);
  if ('refused' in collection) return collection;
  if (located.item.type !== 'request' || !located.item.request) {
    return refuse(`${input.requestId} is a folder; use run_collection with folderId.`);
  }
  const environment = sendEnvironment(input.environmentId, collection, env);
  if (environment && 'refused' in environment) return environment;
  const req = located.item.request;
  const line =
    req.type === 'http' ? `${req.method} ${req.url}` : `${req.type} ${'url' in req ? req.url : ''}`;

  return {
    title: `Send “${located.item.name}”`,
    details: [
      line,
      `Collection “${collection.name}”`,
      environment ? `Environment “${environment.name}”` : 'No environment',
    ],
    run: async () => {
      let captured: RequestCompleteInfo | undefined;
      const run = await runScope({
        collection,
        environment,
        onlyItemId: located.item.id,
        iterations: 1,
        stopOnFailure: false,
        scopeName: `Agent: ${located.item.name}`,
        signal: env.signal,
        onRequestComplete: (info) => {
          captured = info;
        },
      });
      const result = run.requests[0];
      const data = {
        requestId: located.item.id,
        status: result?.status ?? 'failed',
        ...(result?.error ? { error: result.error } : {}),
        ...(result?.skippedReason ? { skippedReason: result.skippedReason } : {}),
        tests: (result?.assertions ?? []).map((a) => ({
          name: a.name,
          passed: a.passed,
          ...(a.error ? { error: a.error } : {}),
        })),
        ...(captured?.response
          ? {
              response: agentResponse(
                captured.response,
                env,
                input.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS
              ),
            }
          : {}),
        runId: run.id,
      };
      const code = captured?.response?.status;
      return {
        data,
        summary: `Sent “${located.item.name}”${code !== undefined ? ` → ${code}` : ''}`,
      };
    },
  };
};

const runCollectionTool: ToolImpl<ControlToolInput<'run_collection'>> = (input, env) => {
  const collection = sendableCollection(input.collectionId, env);
  if ('refused' in collection) return collection;
  if (input.folderId !== undefined) {
    const folder = locateItem([collection], input.folderId);
    if (!folder || folder.item.type !== 'folder') {
      return refuse(`Folder not found in this collection: ${input.folderId}`);
    }
  }
  const environment = sendEnvironment(input.environmentId, collection, env);
  if (environment && 'refused' in environment) return environment;
  const runnables = flattenRunnables(
    collection.items,
    input.folderId,
    rootsOf(collection),
    collection.auth,
    collection
  );
  const iterations = input.iterations ?? 1;
  return {
    title: `Run ${input.folderId ? 'folder' : 'collection'} in “${collection.name}”`,
    details: [
      `${runnables.length} request(s) × ${iterations} iteration(s)`,
      environment ? `Environment “${environment.name}”` : 'No environment',
      input.stopOnFailure ? 'Stops at the first failure' : 'Runs every request',
    ],
    run: async () => {
      const run = await runScope({
        collection,
        environment,
        ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
        iterations,
        stopOnFailure: input.stopOnFailure ?? false,
        scopeName: `Agent: ${collection.name}`,
        signal: env.signal,
      });
      return {
        data: runSummary(run),
        summary: `Ran “${collection.name}”: ${run.summary.passed} passed, ${run.summary.failed} failed`,
      };
    },
  };
};

export const EXECUTE_TOOLS = {
  send_request: sendRequest,
  run_collection: runCollectionTool,
} as const;
