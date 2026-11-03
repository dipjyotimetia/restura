/**
 * Edit + destructive tier tools. Every mutation goes through the same store
 * actions the UI uses (persistence, migrations and soft validation included),
 * and returns an `undo` that restores the affected collection / environment
 * to its state just before the change.
 */

import {
  canCreateCollection,
  canCreateEnvironment,
  canEdit,
  canEditEnvironment,
  canReadEnvironment,
  type McpServerConsent,
  setCollectionConsent,
  setEnvironmentConsent,
} from '@shared/mcp-server/consent';
import type { ControlToolInput } from '@shared/mcp-server/control-tools';
import * as yaml from 'js-yaml';
import { v4 as uuidv4 } from 'uuid';
import { deleteCollectionWithCleanup } from '@/features/collections/lib/deleteCollection';
import {
  type ImportResult,
  type ImportWarning,
  importCurlCommand,
  importInsomniaCollection,
  importOpenAPICollection,
  importOpenCollection,
  validateImportedCollection,
} from '@/features/collections/lib/importers';
import { importPostmanWithReport } from '@/features/collections/lib/importers/postman';
import { makeFolderItem } from '@/features/collections/lib/itemFactory';
import { convertCollectionSecretsToHandles } from '@/lib/shared/secretRef-migrations';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useRequestStore } from '@/store/useRequestStore';
import type { Collection, CollectionItem, Environment } from '@/types';
import { isBrokerRequest } from '@/types';
import { applyRequestPatch, buildRequestFromInput } from '../requestInput';
import { updateMcpConsent } from '../settings';
import { collectItemIds, isDescendant, locateItem, someItem } from '../tree';
import { refuse, SETTINGS_HINT, type ToolEnv, type ToolImpl } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function editableCollection(collectionId: string, env: ToolEnv) {
  const collection = useCollectionStore.getState().getCollectionById(collectionId);
  if (!collection || !canEdit(env.settings.consent, collection.id)) {
    return refuse(
      `Collection not found or not shared for editing: ${collectionId}. ${SETTINGS_HINT}`
    );
  }
  return collection;
}

function editableItem(itemId: string, env: ToolEnv) {
  const located = locateItem(useCollectionStore.getState().collections, itemId);
  if (!located || !canEdit(env.settings.consent, located.collection.id)) {
    return refuse(`Item not found or not shared for editing: ${itemId}. ${SETTINGS_HINT}`);
  }
  return located;
}

function editableEnvironment(environmentId: string, env: ToolEnv) {
  const environment = useEnvironmentStore
    .getState()
    .environments.find((e) => e.id === environmentId);
  if (!environment || !canEditEnvironment(env.settings.consent, environment.id)) {
    return refuse(
      `Environment not found or not shared for editing: ${environmentId}. ${SETTINGS_HINT}`
    );
  }
  return environment;
}

/** Undo by restoring the whole collection as it was before the change. */
function restoreCollection(snapshot: Collection): () => void {
  return () => {
    const store = useCollectionStore.getState();
    if (store.getCollectionById(snapshot.id)) store.updateCollection(snapshot.id, snapshot);
    else store.addCollection(snapshot);
  };
}

function restoreEnvironment(snapshot: Environment): () => void {
  return () => {
    const store = useEnvironmentStore.getState();
    if (store.environments.some((e) => e.id === snapshot.id)) {
      store.updateEnvironment(snapshot.id, snapshot);
    } else {
      store.addEnvironment(snapshot);
    }
  };
}

function folderInCollection(collection: Collection, folderId: string | undefined) {
  if (folderId === undefined) return { ok: true as const };
  const located = locateItem([collection], folderId);
  if (!located || located.item.type !== 'folder') {
    return { ok: false as const, error: `Folder not found in this collection: ${folderId}` };
  }
  return { ok: true as const };
}

/**
 * Give the agent edit access to something it just created — and nothing else —
 * so it can keep working in it. Undoing the create removes the thing itself;
 * a dangling override for a deleted id grants nothing.
 */
function grant(update: (consent: McpServerConsent) => McpServerConsent): void {
  updateMcpConsent(update);
}

function describeRequestLine(request: { type: string; method?: string; url?: string }): string {
  const method = request.type === 'http' ? `${request.method ?? 'GET'} ` : `${request.type} `;
  return `${method}${request.url ?? ''}`.trim();
}

// ---------------------------------------------------------------------------
// Collections, folders, requests
// ---------------------------------------------------------------------------

const createCollection: ToolImpl<ControlToolInput<'create_collection'>> = (input, env) => {
  if (!canCreateCollection(env.settings.consent)) {
    return refuse(
      `Creating collections is not allowed: no collection is shared for editing. ${SETTINGS_HINT}`
    );
  }
  return {
    title: `Create collection “${input.name}”`,
    details: input.description ? [input.description] : [],
    run: () => {
      const store = useCollectionStore.getState();
      const collection = {
        ...store.createNewCollection(input.name),
        ...(input.description ? { description: input.description } : {}),
      };
      store.addCollection(collection);
      grant((c) => setCollectionConsent(c, collection.id, 'edit'));
      return {
        data: { collectionId: collection.id, name: collection.name },
        summary: `Created collection “${collection.name}”`,
        undo: async () => {
          await deleteCollectionWithCleanup(collection.id);
        },
      };
    },
  };
};

const createFolder: ToolImpl<ControlToolInput<'create_folder'>> = (input, env) => {
  const collection = editableCollection(input.collectionId, env);
  if ('refused' in collection) return collection;
  const parent = folderInCollection(collection, input.parentFolderId);
  if (!parent.ok) return refuse(parent.error);
  return {
    title: `Create folder “${input.name}”`,
    details: [`In collection “${collection.name}”`],
    run: () => {
      const snapshot = structuredClone(collection);
      const folder = makeFolderItem(input.name);
      useCollectionStore
        .getState()
        .addItemToCollection(collection.id, folder, input.parentFolderId);
      return {
        data: { folderId: folder.id },
        summary: `Created folder “${input.name}” in “${collection.name}”`,
        undo: restoreCollection(snapshot),
      };
    },
  };
};

const createRequest: ToolImpl<ControlToolInput<'create_request'>> = (input, env) => {
  const collection = editableCollection(input.collectionId, env);
  if ('refused' in collection) return collection;
  const parent = folderInCollection(collection, input.parentFolderId);
  if (!parent.ok) return refuse(parent.error);
  const request = buildRequestFromInput(input.request);
  return {
    title: `Create request “${request.name}”`,
    details: [
      `In collection “${collection.name}”`,
      describeRequestLine(request as { type: string; method?: string; url?: string }),
    ],
    run: () => {
      const snapshot = structuredClone(collection);
      const item: CollectionItem = { id: uuidv4(), name: request.name, type: 'request', request };
      useCollectionStore.getState().addItemToCollection(collection.id, item, input.parentFolderId);
      return {
        data: { requestId: item.id },
        summary: `Created request “${request.name}” in “${collection.name}”`,
        undo: restoreCollection(snapshot),
      };
    },
  };
};

const updateRequest: ToolImpl<ControlToolInput<'update_request'>> = (input, env) => {
  const located = editableItem(input.requestId, env);
  if ('refused' in located) return located;
  const saved = located.item.request;
  if (located.item.type !== 'request' || !saved) {
    return refuse(`${input.requestId} is a folder, not a request`);
  }
  if (!['http', 'grpc', 'sse', 'mcp'].includes(saved.type)) {
    return refuse('Connection presets (Kafka, MQTT, WebSocket, Socket.IO) are edited in Restura.');
  }
  const patched = applyRequestPatch(saved as Parameters<typeof applyRequestPatch>[0], input.patch);
  if (!patched.ok) return refuse(patched.error);
  return {
    title: `Update request “${located.item.name}”`,
    details: [
      `In collection “${located.collection.name}”`,
      `Changes: ${Object.keys(input.patch).join(', ')}`,
    ],
    run: () => {
      const snapshot = structuredClone(located.collection);
      useCollectionStore.getState().updateCollectionItem(located.collection.id, located.item.id, {
        request: patched.request,
        name: patched.request.name,
      });
      // Open tabs on this request keep their own (possibly dirty) copy; the
      // saved definition is what changed.
      return {
        data: { requestId: located.item.id, updated: Object.keys(input.patch) },
        summary: `Updated ${Object.keys(input.patch).join(', ')} of “${located.item.name}”`,
        undo: restoreCollection(snapshot),
      };
    },
  };
};

const renameItem: ToolImpl<ControlToolInput<'rename_item'>> = (input, env) => {
  const located = editableItem(input.itemId, env);
  if ('refused' in located) return located;
  return {
    title: `Rename “${located.item.name}” → “${input.name}”`,
    details: [`In collection “${located.collection.name}”`],
    run: () => {
      const snapshot = structuredClone(located.collection);
      const updates: Partial<CollectionItem> = { name: input.name };
      if (located.item.request) updates.request = { ...located.item.request, name: input.name };
      useCollectionStore
        .getState()
        .updateCollectionItem(located.collection.id, located.item.id, updates);
      return {
        data: { itemId: located.item.id, name: input.name },
        summary: `Renamed “${located.item.name}” to “${input.name}”`,
        undo: restoreCollection(snapshot),
      };
    },
  };
};

const moveItem: ToolImpl<ControlToolInput<'move_item'>> = (input, env) => {
  const located = editableItem(input.itemId, env);
  if ('refused' in located) return located;
  const target = folderInCollection(located.collection, input.targetFolderId);
  if (!target.ok) return refuse(target.error);
  if (
    input.targetFolderId !== undefined &&
    (input.targetFolderId === located.item.id || isDescendant(located.item, input.targetFolderId))
  ) {
    return refuse('Cannot move a folder into itself.');
  }
  return {
    title: `Move “${located.item.name}”`,
    details: [
      `In collection “${located.collection.name}”`,
      input.targetFolderId ? 'Into another folder' : 'To the collection root',
    ],
    run: () => {
      const snapshot = structuredClone(located.collection);
      useCollectionStore
        .getState()
        .moveCollectionItem(
          located.collection.id,
          located.item.id,
          input.targetFolderId !== undefined ? { parentId: input.targetFolderId } : {}
        );
      return {
        data: { itemId: located.item.id, parentFolderId: input.targetFolderId ?? null },
        summary: `Moved “${located.item.name}”`,
        undo: restoreCollection(snapshot),
      };
    },
  };
};

async function parseImport(
  format: ControlToolInput<'import_collection'>['format'],
  content: string
): Promise<ImportResult> {
  if (format === 'curl') return importCurlCommand(content);
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    if (format !== 'openapi') throw new Error(`The ${format} document is not valid JSON.`);
    // json: true makes duplicate keys an error rather than a silent override;
    // the default schema (no custom tags) cannot instantiate objects.
    data = yaml.load(content, { json: true });
  }
  switch (format) {
    case 'postman':
      return importPostmanWithReport(data);
    case 'insomnia':
      return importInsomniaCollection(data);
    case 'opencollection':
      return importOpenCollection(data);
    case 'openapi': {
      const warnings: ImportWarning[] = [];
      const collection = await importOpenAPICollection(data, warnings);
      return { collection, warnings };
    }
  }
}

function countRequests(items: CollectionItem[]): number {
  return items.reduce(
    (n, it) => n + (it.type === 'request' ? 1 : countRequests(it.items ?? [])),
    0
  );
}

const importCollection: ToolImpl<ControlToolInput<'import_collection'>> = (input, env) => {
  if (!canCreateCollection(env.settings.consent)) {
    return refuse(
      `Importing is not allowed: no collection is shared for editing. ${SETTINGS_HINT}`
    );
  }
  return {
    title: `Import ${input.format} collection${input.name ? ` “${input.name}”` : ''}`,
    details: [`${input.content.length.toLocaleString()} characters of ${input.format}`],
    run: async () => {
      const result = await parseImport(input.format, input.content);
      const validation = validateImportedCollection(result.collection);
      if (!validation.ok) {
        throw new Error(`Imported collection failed validation — ${validation.issues.join('; ')}`);
      }
      const named = input.name ? { ...result.collection, name: input.name } : result.collection;
      // Credentials inside the imported document become desktop keychain
      // handles, so they are neither readable by the agent nor stored in
      // plaintext (no-op on web).
      const collection = await convertCollectionSecretsToHandles(named);
      useCollectionStore.getState().addCollection(collection);
      grant((c) => setCollectionConsent(c, collection.id, 'edit'));
      // Imported environments are not added: they can carry credentials, and
      // the agent has no environment grant for them. The user can import
      // those from Restura's Import dialog.
      return {
        data: {
          collectionId: collection.id,
          name: collection.name,
          requestCount: countRequests(collection.items),
          warnings: result.warnings
            .slice(0, 50)
            .map((w) => ('requestName' in w ? `${w.kind}: ${w.requestName}` : w.kind)),
          skippedEnvironments: result.environments?.length ?? 0,
        },
        summary: `Imported “${collection.name}” (${countRequests(collection.items)} requests)`,
        undo: async () => {
          await deleteCollectionWithCleanup(collection.id);
        },
      };
    },
  };
};

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

const createEnvironment: ToolImpl<ControlToolInput<'create_environment'>> = (input, env) => {
  if (!canCreateEnvironment(env.settings.consent)) {
    return refuse(
      `Creating environments is not allowed: no environment is shared for editing. ${SETTINGS_HINT}`
    );
  }
  const variables = input.variables ?? [];
  return {
    title: `Create environment “${input.name}”`,
    details: variables.length > 0 ? [`Variables: ${variables.map((v) => v.key).join(', ')}`] : [],
    run: () => {
      const store = useEnvironmentStore.getState();
      const environment: Environment = {
        ...store.createNewEnvironment(input.name),
        variables: variables.map((v) => ({
          id: uuidv4(),
          key: v.key,
          value: v.value,
          enabled: true,
        })),
      };
      store.addEnvironment(environment);
      grant((c) => setEnvironmentConsent(c, environment.id, 'edit'));
      return {
        data: { environmentId: environment.id, name: environment.name },
        summary: `Created environment “${environment.name}”`,
        undo: () => useEnvironmentStore.getState().removeEnvironment(environment.id),
      };
    },
  };
};

const setEnvironmentVariable: ToolImpl<ControlToolInput<'set_environment_variable'>> = (
  input,
  env
) => {
  const environment = editableEnvironment(input.environmentId, env);
  if ('refused' in environment) return environment;
  const existing = environment.variables.find((v) => v.key === input.key);
  if (existing?.secret || existing?.secretRef) {
    return refuse(
      `“${input.key}” is a secret variable. Use request_secret_variable so the user types the value.`
    );
  }
  return {
    title: `${existing ? 'Update' : 'Add'} variable “${input.key}”`,
    details: [`In environment “${environment.name}”`, `Value: ${input.value}`],
    run: () => {
      const snapshot = structuredClone(environment);
      const store = useEnvironmentStore.getState();
      if (existing) {
        store.updateVariable(environment.id, existing.id, {
          value: input.value,
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        });
      } else {
        store.addVariable(environment.id, {
          id: uuidv4(),
          key: input.key,
          value: input.value,
          enabled: input.enabled ?? true,
        });
      }
      return {
        data: { environmentId: environment.id, key: input.key },
        summary: `Set “${input.key}” in “${environment.name}”`,
        undo: restoreEnvironment(snapshot),
      };
    },
  };
};

const requestSecretVariable: ToolImpl<ControlToolInput<'request_secret_variable'>> = (
  input,
  env
) => {
  const environment = editableEnvironment(input.environmentId, env);
  if ('refused' in environment) return environment;
  const existing = environment.variables.find((v) => v.key === input.key);
  if (existing?.secretRef) {
    return refuse(
      `“${input.key}” is stored in the desktop keychain; the user manages it in Restura.`
    );
  }
  return {
    title: `Secret “${input.key}” for “${environment.name}”`,
    details: [input.reason],
    secretPrompt: { environmentName: environment.name, key: input.key, reason: input.reason },
    run: ({ secretValue }) => {
      if (secretValue === undefined) throw new Error('No value was entered.');
      const snapshot = structuredClone(environment);
      const store = useEnvironmentStore.getState();
      if (existing) {
        store.updateVariable(environment.id, existing.id, {
          value: secretValue,
          secret: true,
          enabled: true,
        });
      } else {
        store.addVariable(environment.id, {
          id: uuidv4(),
          key: input.key,
          value: secretValue,
          enabled: true,
          secret: true,
        });
      }
      return {
        // The value never goes back to the agent.
        data: {
          environmentId: environment.id,
          key: input.key,
          set: true,
          reference: `{{${input.key}}}`,
        },
        summary: `User set secret “${input.key}” in “${environment.name}”`,
        undo: restoreEnvironment(snapshot),
      };
    },
  };
};

const setActiveEnvironment: ToolImpl<ControlToolInput<'set_active_environment'>> = (input, env) => {
  const store = useEnvironmentStore.getState();
  const target = input.environmentId
    ? store.environments.find((e) => e.id === input.environmentId)
    : undefined;
  if (input.environmentId && (!target || !canReadEnvironment(env.settings.consent, target.id))) {
    return refuse(`Environment not found or not shared: ${input.environmentId}. ${SETTINGS_HINT}`);
  }
  return {
    title: target ? `Switch to environment “${target.name}”` : 'Clear the active environment',
    details: [],
    run: () => {
      const previous = useEnvironmentStore.getState().activeEnvironmentId;
      useEnvironmentStore.getState().setActiveEnvironment(target?.id ?? null);
      return {
        data: { activeEnvironmentId: target?.id ?? null },
        summary: target ? `Switched to “${target.name}”` : 'Cleared the active environment',
        undo: () => useEnvironmentStore.getState().setActiveEnvironment(previous),
      };
    },
  };
};

// ---------------------------------------------------------------------------
// Destructive
// ---------------------------------------------------------------------------

const deleteItem: ToolImpl<ControlToolInput<'delete_item'>> = (input, env) => {
  const located = editableItem(input.itemId, env);
  if ('refused' in located) return located;
  if (someItem(located.item, (it) => isBrokerRequest(it.request))) {
    return refuse(
      'This contains Kafka/MQTT presets with stored credentials; ask the user to delete it in Restura.'
    );
  }
  const ids = collectItemIds(located.item);
  const requestCount =
    located.item.type === 'request' ? 1 : countRequests(located.item.items ?? []);
  return {
    title: `Delete ${located.item.type} “${located.item.name}”`,
    details: [
      `From collection “${located.collection.name}”`,
      located.item.type === 'folder' ? `Includes ${requestCount} request(s)` : '',
    ].filter(Boolean),
    run: () => {
      const snapshot = structuredClone(located.collection);
      useCollectionStore.getState().removeCollectionItem(located.collection.id, located.item.id);
      useRequestStore.getState().detachTabsFromSavedRequests(ids);
      return {
        data: { deleted: located.item.id },
        summary: `Deleted ${located.item.type} “${located.item.name}”`,
        undo: restoreCollection(snapshot),
      };
    },
  };
};

const deleteCollection: ToolImpl<ControlToolInput<'delete_collection'>> = (input, env) => {
  const collection = editableCollection(input.collectionId, env);
  if ('refused' in collection) return collection;
  if (collection.items.some((it) => someItem(it, (x) => isBrokerRequest(x.request)))) {
    return refuse(
      'This collection contains Kafka/MQTT presets with stored credentials; ask the user to delete it in Restura.'
    );
  }
  return {
    title: `Delete collection “${collection.name}”`,
    details: [`${countRequests(collection.items)} request(s) will be removed`],
    run: async () => {
      const snapshot = structuredClone(collection);
      const result = await deleteCollectionWithCleanup(collection.id);
      if (!result.success) throw new Error(result.error ?? 'Delete failed');
      return {
        data: { deleted: collection.id },
        summary: `Deleted collection “${collection.name}”`,
        undo: restoreCollection(snapshot),
      };
    },
  };
};

const deleteEnvironmentVariable: ToolImpl<ControlToolInput<'delete_environment_variable'>> = (
  input,
  env
) => {
  const environment = editableEnvironment(input.environmentId, env);
  if ('refused' in environment) return environment;
  const variable = environment.variables.find((v) => v.key === input.key);
  if (!variable) return refuse(`No variable “${input.key}” in “${environment.name}”`);
  return {
    title: `Delete variable “${input.key}”`,
    details: [`From environment “${environment.name}”`],
    run: () => {
      const snapshot = structuredClone(environment);
      useEnvironmentStore.getState().removeVariable(environment.id, variable.id);
      return {
        data: { deleted: input.key },
        summary: `Deleted “${input.key}” from “${environment.name}”`,
        undo: restoreEnvironment(snapshot),
      };
    },
  };
};

export const EDIT_TOOLS = {
  create_collection: createCollection,
  create_folder: createFolder,
  create_request: createRequest,
  update_request: updateRequest,
  rename_item: renameItem,
  move_item: moveItem,
  import_collection: importCollection,
  create_environment: createEnvironment,
  set_environment_variable: setEnvironmentVariable,
  request_secret_variable: requestSecretVariable,
  set_active_environment: setActiveEnvironment,
  delete_item: deleteItem,
  delete_collection: deleteCollection,
  delete_environment_variable: deleteEnvironmentVariable,
} as const;
