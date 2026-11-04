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
  canRead,
  canReadEnvironment,
} from '@shared/mcp-server/consent';
import type { ControlToolInput } from '@shared/mcp-server/control-tools';
import { redactBodyForAgent, redactHeadersForAgent } from '@shared/mcp-server/redaction';
import {
  type CollectionRunResult,
  type RequestCompleteInfo,
  runCollection,
} from '@/features/collections/lib/collectionRunner';
import {
  flattenRunnables,
  type RunnableRequest,
} from '@/features/collections/lib/flattenRunnables';
import { resolveRunVariables } from '@/features/collections/lib/runVariables';
import { useCollectionRunStore } from '@/store/useCollectionRunStore';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import type { Response as ApiResponse, Collection, Environment } from '@/types';
import { ancestorFolders, locateItem } from '../tree';
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
  // A sub-environment inherits its parent's variables (and credentials), so
  // the parent must be opted in for sending too.
  if (
    environment.parentId !== undefined &&
    !canExecuteWithEnvironment(env.settings.consent, environment.parentId)
  ) {
    return refuse(
      `This environment inherits from a parent environment that agents may not send with. ${SETTINGS_HINT}`
    );
  }
  return environment;
}

/**
 * Everything a send depends on: the collection (requests, folder auth and
 * scripts, collection vars), the environment chain and the globals. An
 * approval is only valid while this is unchanged.
 */
function sendFingerprint(collection: Collection, environment: Environment | null): string {
  const environments = useEnvironmentStore.getState().environments;
  const parent = environment?.parentId
    ? environments.find((e) => e.id === environment.parentId)
    : undefined;
  return JSON.stringify([collection, environment, parent, useGlobalsStore.getState().vars]);
}

/** `{{name}}` substituted from the run's variables, for the approval card only. */
function resolvedForDisplay(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (match, name: string) => vars[name] ?? match);
}

/**
 * The auth a runnable is sent with, resolved as the runner does at send time
 * (`withEffectiveAuth`): its own unless that is `none`, then the nearest
 * folder's, else the collection's. Type only — never the credentials.
 */
function effectiveAuth(r: RunnableRequest): { type: string; inherited: boolean } {
  const own = r.request.auth?.type ?? 'none';
  if (own === 'none' && r.inheritedAuth && r.inheritedAuth.type !== 'none') {
    return { type: r.inheritedAuth.type, inherited: true };
  }
  return { type: own, inherited: false };
}

/** Most distinct destinations a run_collection card lists before "+N more". */
const MAX_CARD_DESTINATIONS = 8;

/**
 * Where a run will send, for the approval card: each distinct method,
 * `scheme://host` (variables resolved as for send_request) and auth type.
 * A run of "13 requests" alone would hide that an agent pointed one of them,
 * with credentials, at a new host.
 */
function runDestinations(runnables: RunnableRequest[], vars: Record<string, string>): string[] {
  const seen = new Set<string>();
  for (const r of runnables) {
    const req = r.request;
    const url = resolvedForDisplay(
      'url' in req && typeof req.url === 'string' ? req.url : '',
      vars
    );
    const verb = req.type === 'http' ? req.method : req.type;
    // scheme://host only: never userinfo (a saved password) or the path.
    const m = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/?#@]*@)?([^/?#]*)/i.exec(url);
    const origin = m ? `${m[1]}${m[2]}` : url || '(no URL)';
    const { type: auth } = effectiveAuth(r);
    seen.add(`${verb} ${origin}${auth !== 'none' ? ` (auth: ${auth})` : ''}`);
  }
  const all = [...seen];
  const shown = all.slice(0, MAX_CARD_DESTINATIONS);
  if (all.length > shown.length) shown.push(`+${all.length - shown.length} more destination(s)`);
  return shown.map((line) => `Sends to: ${line}`);
}

/** Card lines naming every script that will run for one request. */
function scriptsForRequest(collection: Collection, itemId: string): string[] {
  const named: string[] = [];
  const add = (
    label: string,
    node: { preRequestScript?: string; testScript?: string } | undefined
  ) => {
    if (node?.preRequestScript?.trim()) named.push(`${label} pre-request`);
    if (node?.testScript?.trim()) named.push(`${label} test`);
  };
  add('collection', collection);
  for (const folder of ancestorFolders(collection.items, itemId) ?? [])
    add(`folder “${folder.name}”`, folder);
  const item = locateItem([collection], itemId)?.item;
  add('request', item?.request as { preRequestScript?: string; testScript?: string } | undefined);
  return named;
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
  // Hidden and missing must read the same: a hidden collection's ids are not confirmable.
  if (!located || !canRead(env.settings.consent, located.collection.id)) {
    return refuse(`Request not found: ${input.requestId}`);
  }
  const collection = sendableCollection(located.collection.id, env);
  if ('refused' in collection) return collection;
  if (located.item.type !== 'request' || !located.item.request) {
    return refuse(`${input.requestId} is a folder; use run_collection with folderId.`);
  }
  const environment = sendEnvironment(input.environmentId, collection, env);
  if (environment && 'refused' in environment) return environment;
  const req = located.item.request;
  const url = 'url' in req && typeof req.url === 'string' ? req.url : '';
  const verb = req.type === 'http' ? req.method : req.type;
  const resolved = resolvedForDisplay(
    url,
    resolveRunVariables(environment?.id ?? 'none', collection).baseVars
  );
  const scripts = scriptsForRequest(collection, located.item.id);
  // The card must show credentials the send will attach, including auth a
  // request with `none` picks up from its folder or collection at send time.
  const runnable = flattenRunnables(
    collection.items,
    undefined,
    rootsOf(collection),
    collection.auth,
    collection
  ).find((r) => r.itemId === located.item.id);
  const auth = runnable
    ? effectiveAuth(runnable)
    : { type: req.auth?.type ?? 'none', inherited: false };

  return {
    title: `Send “${located.item.name}”`,
    details: [
      `${verb} ${url}`,
      ...(resolved !== url ? [`Resolves to: ${verb} ${resolved}`] : []),
      `Auth: ${auth.type}${auth.inherited ? ' (inherited from folder/collection)' : ''}`,
      ...(runnable?.blocked ? [`Will not send: ${runnable.blocked}`] : []),
      `Collection “${collection.name}”`,
      environment ? `Environment “${environment.name}”` : 'No environment',
      scripts.length > 0 ? `Runs scripts: ${scripts.join(', ')}` : 'No scripts',
    ],
    fingerprint: sendFingerprint(collection, environment),
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
    if (folder?.item.type !== 'folder') {
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
    fingerprint: sendFingerprint(collection, environment),
    details: [
      `${runnables.length} request(s) × ${iterations} iteration(s)`,
      ...runDestinations(
        runnables,
        resolveRunVariables(environment?.id ?? 'none', collection).baseVars
      ),
      environment ? `Environment “${environment.name}”` : 'No environment',
      input.stopOnFailure ? 'Stops at the first failure' : 'Runs every request',
      (() => {
        const scripted = runnables.filter(
          (r) => scriptsForRequest(collection, r.itemId).length > 0
        ).length;
        return scripted > 0 ? `${scripted} request(s) run scripts` : 'No scripts';
      })(),
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
