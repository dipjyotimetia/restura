/**
 * Read / UI tier tools. Every response is redacted before it leaves this
 * module; the pure snapshot dispatcher (`@shared/mcp-server/dispatch`) is
 * reused for the tools it already owns so its consent + redaction tests keep
 * covering them.
 */

import {
  canEdit,
  canEditEnvironment,
  canExecute,
  canExecuteWithEnvironment,
  canRead,
  canReadEnvironment,
  canReadHistory,
} from '@shared/mcp-server/consent';
import type { ControlToolInput } from '@shared/mcp-server/control-tools';
import { dispatchTool, type McpDispatchContext } from '@shared/mcp-server/dispatch';
import { redactSecretsDeep, redactUrlCredentials } from '@shared/mcp-server/redaction';
import { openCollectionItem } from '@/features/collections/lib/openCollectionItem';
import { useCollectionRunStore } from '@/store/useCollectionRunStore';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import type { CollectionItem } from '@/types';
import { redactKeyValues, redactSavedText } from '../savedRedaction';
import { locateItem, type TreeNode } from '../tree';
import { refuse, SETTINGS_HINT, type ToolEnv, type ToolImpl } from './types';

export function snapshotContext(env: ToolEnv): McpDispatchContext {
  return {
    collections: useCollectionStore.getState().collections,
    environments: useEnvironmentStore.getState().environments,
    history: useHistoryStore.getState().history,
    consent: env.settings.consent,
  };
}

/**
 * "Hidden" and "missing" must read the same, so an agent cannot confirm a
 * hidden collection or environment exists by probing ids.
 */
function uniformRefusal(name: string, input: unknown, error: string): string {
  if (!/hidden from MCP agents|not found/i.test(error)) return error;
  const ids = input as { collectionId?: string; id?: string } | undefined;
  if (name === 'list_requests' && !/Folder path/.test(error)) {
    return `Collection not found or not shared: ${ids?.collectionId ?? ''}. ${SETTINGS_HINT}`;
  }
  if (name === 'get_environment') {
    return `Environment not found or not shared: ${ids?.id ?? ''}. ${SETTINGS_HINT}`;
  }
  return error;
}

/** Wrap a pure-dispatcher tool as a (read-tier) control tool. */
function viaDispatcher(name: string, summary: string): ToolImpl<unknown> {
  return (input, env) => {
    const result = dispatchTool(name, input, snapshotContext(env));
    if (!result.ok) return refuse(uniformRefusal(name, input, result.error));
    return { title: summary, details: [], run: () => ({ data: result.data, summary }) };
  };
}

function itemSummary(item: CollectionItem): TreeNode {
  if (item.type === 'folder') {
    return {
      id: item.id,
      name: item.name,
      type: 'folder',
      children: (item.items ?? []).map(itemSummary),
    };
  }
  const req = item.request;
  return {
    id: item.id,
    name: item.name,
    type: 'request',
    ...(req ? { requestType: req.type } : {}),
    ...(req?.type === 'http' ? { method: req.method } : {}),
    ...(req && 'url' in req && typeof req.url === 'string'
      ? { url: redactUrlCredentials(req.url) ?? '' }
      : {}),
  };
}

const redactText = redactSavedText;

/** The full, redacted, agent-visible definition of a saved request. */
export function describeSavedRequest(item: CollectionItem, path: string[]) {
  const req = item.request;
  if (!req) return { id: item.id, name: item.name, path, type: 'unknown' };
  const base = {
    id: item.id,
    name: item.name,
    path,
    type: req.type,
    ...('auth' in req && req.auth ? { auth: redactSecretsDeep(req.auth) } : {}),
    ...('preRequestScript' in req && req.preRequestScript
      ? { preRequestScript: req.preRequestScript }
      : {}),
    ...('testScript' in req && req.testScript ? { testScript: req.testScript } : {}),
  };
  switch (req.type) {
    case 'http':
      return {
        ...base,
        method: req.method,
        url: redactUrlCredentials(req.url),
        headers: redactKeyValues(req.headers),
        params: redactKeyValues(req.params),
        body: {
          type: req.body.type,
          ...(req.body.raw !== undefined
            ? {
                content: redactText(req.body.raw),
              }
            : {}),
          ...(req.body.graphqlVariables !== undefined
            ? { graphqlVariables: redactText(req.body.graphqlVariables) }
            : {}),
          ...(req.body.formData
            ? { formFields: req.body.formData.map((f) => ({ key: f.key, type: f.type })) }
            : {}),
        },
        // Saved docs are often imported from third-party specs: untrusted.
        ...(req.description ? { untrustedContent: { description: req.description } } : {}),
      };
    case 'grpc':
      return {
        ...base,
        url: redactUrlCredentials(req.url),
        service: req.service,
        method: req.method,
        methodType: req.methodType,
        message: redactText(req.message),
        metadata: redactKeyValues(req.metadata),
      };
    case 'sse':
      return {
        ...base,
        url: redactUrlCredentials(req.url),
        headers: redactKeyValues(req.headers),
        params: redactKeyValues(req.params),
      };
    case 'mcp':
      return {
        ...base,
        url: redactUrlCredentials(req.url),
        transport: req.transport,
        headers: redactKeyValues(req.headers),
        ...(req.defaultMethod ? { defaultMethod: req.defaultMethod } : {}),
        ...(req.defaultParams ? { defaultParams: redactText(req.defaultParams) } : {}),
      };
    default:
      // Kafka / MQTT / WebSocket / Socket.IO connection presets: identity only.
      return { ...base, auth: undefined, note: 'Connection preset — open it in Restura to view.' };
  }
}

/** Locate a saved request the agent may read, or refuse with the reason. */
export function readableItem(requestId: string, env: ToolEnv) {
  const located = locateItem(useCollectionStore.getState().collections, requestId);
  if (!located || !canRead(env.settings.consent, located.collection.id)) {
    // Same message for "missing" and "hidden": a hidden collection's ids must
    // not be confirmable by probing.
    return refuse(`Request not found: ${requestId}`);
  }
  return located;
}

const describeAccess: ToolImpl<ControlToolInput<'describe_access'>> = (_input, env) => {
  const { consent, approvalMode } = env.settings;
  const collections = useCollectionStore.getState().collections;
  const environments = useEnvironmentStore.getState().environments;
  const data = {
    collections: {
      readable: collections.filter((c) => canRead(consent, c.id)).length,
      editable: collections.filter((c) => canEdit(consent, c.id)).length,
      sendable: collections.filter((c) => canExecute(consent, c.id)).length,
      hidden: collections.filter((c) => !canRead(consent, c.id)).length,
    },
    environments: {
      readable: environments.filter((e) => canReadEnvironment(consent, e.id)).length,
      editable: environments.filter((e) => canEditEnvironment(consent, e.id)).length,
      sendable: environments.filter(
        (e) => canReadEnvironment(consent, e.id) && canExecuteWithEnvironment(consent, e.id)
      ).length,
    },
    history: canReadHistory(consent) ? 'readable' : 'hidden',
    approvalMode,
    approvals:
      approvalMode === 'auto-approve-edits'
        ? 'Creates and updates apply immediately; deletes and sends wait for the user.'
        : 'Every change and send waits for the user to approve it in Restura.',
    responseBodyRedaction: env.settings.redactResponseBodies,
  };
  return {
    title: 'Describe access',
    details: [],
    run: () => ({ data, summary: 'Described access' }),
  };
};

const listEnvironments: ToolImpl<ControlToolInput<'list_environments'>> = (_input, env) => {
  const { consent } = env.settings;
  const data = {
    environments: useEnvironmentStore
      .getState()
      .environments.filter((e) => canReadEnvironment(consent, e.id))
      .map((e) => ({
        id: e.id,
        name: e.name,
        variableCount: e.variables.filter((v) => v.enabled !== false).length,
        editable: canEditEnvironment(consent, e.id),
        sendable: canExecuteWithEnvironment(consent, e.id),
        active: useEnvironmentStore.getState().activeEnvironmentId === e.id,
      })),
  };
  return {
    title: 'List environments',
    details: [],
    run: () => ({ data, summary: 'Listed environments' }),
  };
};

const getCollectionTree: ToolImpl<ControlToolInput<'get_collection_tree'>> = (input, env) => {
  const collection = useCollectionStore.getState().getCollectionById(input.collectionId);
  if (!collection || !canRead(env.settings.consent, collection.id)) {
    return refuse(`Collection not found or not shared: ${input.collectionId}. ${SETTINGS_HINT}`);
  }
  const data = {
    id: collection.id,
    name: collection.name,
    ...(collection.description
      ? { untrustedContent: { description: collection.description } }
      : {}),
    editable: canEdit(env.settings.consent, collection.id),
    sendable: canExecute(env.settings.consent, collection.id),
    items: collection.items.map(itemSummary),
  };
  return {
    title: `Read collection “${collection.name}”`,
    details: [],
    run: () => ({ data, summary: `Read the tree of “${collection.name}”` }),
  };
};

const getRequest: ToolImpl<ControlToolInput<'get_request'>> = (input, env) => {
  const located = readableItem(input.requestId, env);
  if ('refused' in located) return located;
  if (located.item.type !== 'request')
    return refuse(`${input.requestId} is a folder, not a request`);
  const data = describeSavedRequest(located.item, located.path);
  return {
    title: `Read request “${located.item.name}”`,
    details: [],
    run: () => ({ data, summary: `Read request “${located.item.name}”` }),
  };
};

const listCollectionRuns: ToolImpl<ControlToolInput<'list_collection_runs'>> = (input, env) => {
  if (!canRead(env.settings.consent, input.collectionId)) {
    return refuse(`Collection not found or not shared: ${input.collectionId}. ${SETTINGS_HINT}`);
  }
  const runs = useCollectionRunStore
    .getState()
    .runs.filter((r) => r.collectionId === input.collectionId)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, input.limit ?? 10)
    .map((r) => ({
      id: r.id,
      scope: r.scopeName,
      startedAt: r.startedAt,
      durationMs: r.durationMs,
      outcome: r.outcome,
      summary: r.summary,
      failures: r.requests
        .filter((q) => q.status === 'failed')
        .slice(0, 20)
        .map((q) => ({
          request: q.itemName,
          status: q.httpStatus,
          ...(q.error ? { error: q.error } : {}),
          failedAssertions: q.assertions.filter((a) => !a.passed).map((a) => a.name),
        })),
    }));
  return {
    title: 'List collection runs',
    details: [],
    run: () => ({ data: { runs }, summary: 'Listed collection runs' }),
  };
};

const openRequest: ToolImpl<ControlToolInput<'open_request'>> = (input, env) => {
  const located = readableItem(input.requestId, env);
  if ('refused' in located) return located;
  return {
    title: `Open “${located.item.name}”`,
    details: [],
    run: () => {
      const opened = openCollectionItem(located.item);
      return {
        data: { opened },
        summary: `Opened “${located.item.name}” in a tab`,
      };
    },
  };
};

export const READ_TOOLS = {
  describe_access: describeAccess,
  list_collections: viaDispatcher('list_collections', 'Listed collections'),
  get_collection_tree: getCollectionTree,
  list_requests: viaDispatcher('list_requests', 'Listed requests'),
  get_request: getRequest,
  list_environments: listEnvironments,
  get_environment: viaDispatcher('get_environment', 'Read an environment'),
  get_history: viaDispatcher('get_history', 'Read request history'),
  list_collection_runs: listCollectionRuns,
  open_request: openRequest,
} as const;
