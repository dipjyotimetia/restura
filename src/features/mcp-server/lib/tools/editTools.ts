/**
 * Edit + destructive tier tools. Every mutation goes through the same store
 * actions the UI uses (persistence, migrations and soft validation included),
 * and returns an `undo` that restores the affected collection / environment
 * to its state just before the change.
 */

import { canCreateCollection, canEdit, setCollectionConsent } from '@shared/mcp-server/consent';
import { type ControlToolInput, MAX_AGENT_SCRIPT_CHARS } from '@shared/mcp-server/control-tools';
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
import { useFileCollectionStore } from '@/store/useFileCollectionStore';
import { useRequestStore } from '@/store/useRequestStore';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import type { Collection, CollectionItem } from '@/types';
import { isBrokerRequest } from '@/types';
import { applyRequestPatch, buildRequestFromInput } from '../requestInput';
import { containsPlaceholder, restoreRedactedPatch } from '../savedRedaction';
import { collectItemIds, isDescendant, locateItem, someItem } from '../tree';
import { fingerprint, grant, UndoConflictError } from './editShared';
import { clip, refuse, SETTINGS_HINT, scriptDetails, type ToolEnv, type ToolImpl } from './types';

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

const currentCollection = (id: string) => useCollectionStore.getState().getCollectionById(id);
/**
 * Undo for a collection change. Must be created right AFTER the change: it
 * records the post-change state and only restores `before` while the
 * collection is still exactly that, so it can never wipe later edits. `before`
 * undefined means the change created the collection; a missing collection
 * after the change means it deleted it.
 */
function restoreCollection(
  before: Collection | undefined,
  id: string = before?.id ?? ''
): () => Promise<void> {
  const after = fingerprint(currentCollection(id));
  return async () => {
    if (fingerprint(currentCollection(id)) !== after) {
      throw new UndoConflictError(
        `Collection “${before?.name ?? currentCollection(id)?.name ?? id}”`
      );
    }
    const store = useCollectionStore.getState();
    if (!before) {
      const result = await deleteCollectionWithCleanup(id);
      if (!result.success) throw new Error(result.error ?? 'Could not remove the collection.');
    } else if (store.getCollectionById(id)) {
      store.updateCollection(id, before);
    } else {
      store.addCollection(before);
    }
  };
}

function folderInCollection(collection: Collection, folderId: string | undefined) {
  if (folderId === undefined) return { ok: true as const };
  const located = locateItem([collection], folderId);
  if (located?.item.type !== 'folder') {
    return { ok: false as const, error: `Folder not found in this collection: ${folderId}` };
  }
  return { ok: true as const };
}

type MaybeScripted = { preRequestScript?: string; testScript?: string } | undefined;

function scriptLines(label: string, node: MaybeScripted): string[] {
  return [
    ...scriptDetails(`${label} pre-request script`, node?.preRequestScript),
    ...scriptDetails(`${label} test script`, node?.testScript),
  ];
}

const existingCollectionIds = () =>
  new Set(useCollectionStore.getState().collections.map((c) => c.id));

/** Every non-empty script in a collection (collection, folders, requests), labelled. */
function scriptsIn(collection: Collection): string[] {
  const out = scriptLines('Collection', collection);
  const walk = (items: CollectionItem[], path: string) => {
    for (const item of items) {
      const label = path ? `${path} / ${item.name}` : item.name;
      if (item.type === 'folder') {
        out.push(...scriptLines(`Folder “${label}”`, item));
        walk(item.items ?? [], label);
      } else {
        out.push(...scriptLines(`Request “${label}”`, item.request as MaybeScripted));
      }
    }
  };
  walk(collection.items, '');
  return out;
}

function describeRequestLine(request: { type: string; method?: string; url?: string }): string {
  const method = request.type === 'http' ? `${request.method ?? 'GET'} ` : `${request.type} `;
  return `${method}${request.url ?? ''}`.trim();
}

// ---------------------------------------------------------------------------
// Collections, folders, requests
// ---------------------------------------------------------------------------

const createCollection: ToolImpl<ControlToolInput<'create_collection'>> = (input, env) => {
  if (!canCreateCollection(env.settings.consent, existingCollectionIds())) {
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
        undo: restoreCollection(undefined, collection.id),
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
    fingerprint: fingerprint(collection),
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
  if (containsPlaceholder(input.request)) {
    return refuse(
      'The request contains a redaction placeholder such as "(redacted)". Use a {{variable}} for secrets instead of copying redacted values.'
    );
  }
  const request = buildRequestFromInput(input.request);
  const scripts = [
    ...scriptDetails('Pre-request script', input.request.preRequestScript),
    ...scriptDetails('Test script', input.request.testScript),
  ];
  return {
    title: `Create request “${request.name}”`,
    details: [
      `In collection “${collection.name}”`,
      clip(describeRequestLine(request as { type: string; method?: string; url?: string })),
      ...scripts,
    ],
    // A script runs with full script powers (variables, vault, cookies,
    // network) on every later send: always shown in full and always asked.
    alwaysAsk: scripts.length > 0,
    // Request ids are minted per prepare; bind to the collection instead.
    fingerprint: fingerprint([collection, input]),
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

/** One card line per changed field, with its new value (scripts in full). */
function describePatch(patch: ControlToolInput<'update_request'>['patch']): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'preRequestScript' || key === 'testScript') {
      const label = key === 'preRequestScript' ? 'New pre-request script' : 'New test script';
      lines.push(
        ...(String(value).trim() === ''
          ? [`${label}: (removed)`]
          : scriptDetails(label, String(value)))
      );
    } else {
      lines.push(`${key} → ${clip(typeof value === 'string' ? value : JSON.stringify(value))}`);
    }
  }
  return lines;
}

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
  // Values copied back from get_request keep their real saved value; any
  // other redaction placeholder is refused so it can never overwrite a secret.
  const savedRequest = saved as Parameters<typeof applyRequestPatch>[0];
  const safePatch = restoreRedactedPatch(savedRequest, input.patch);
  if (!safePatch.ok) return refuse(safePatch.error);
  const patched = applyRequestPatch(
    saved as Parameters<typeof applyRequestPatch>[0],
    safePatch.value
  );
  if (!patched.ok) return refuse(patched.error);
  return {
    title: `Update request “${located.item.name}”`,
    details: [`In collection “${located.collection.name}”`, ...describePatch(input.patch)],
    alwaysAsk: input.patch.preRequestScript !== undefined || input.patch.testScript !== undefined,
    fingerprint: fingerprint(located.collection),
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
    fingerprint: fingerprint(located.collection),
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
    fingerprint: fingerprint(located.collection),
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

const importCollection: ToolImpl<ControlToolInput<'import_collection'>> = async (input, env) => {
  if (!canCreateCollection(env.settings.consent, existingCollectionIds())) {
    return refuse(
      `Importing is not allowed: no collection is shared for editing. ${SETTINGS_HINT}`
    );
  }
  // Parse before asking, so the card can show what the document contains —
  // in particular any scripts, which would run on every later send.
  let result: ImportResult;
  try {
    result = await parseImport(input.format, input.content);
  } catch (err) {
    return refuse(
      `Could not parse the ${input.format} document: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const validation = validateImportedCollection(result.collection);
  if (!validation.ok) {
    return refuse(`Imported collection failed validation — ${validation.issues.join('; ')}`);
  }
  const scripts = scriptsIn(result.collection);
  if (scripts.join('\n').length > MAX_AGENT_SCRIPT_CHARS) {
    return refuse(
      'This document contains more script code than can be shown for review. Ask the user to import it from Restura’s Import dialog instead.'
    );
  }
  const name = input.name ?? result.collection.name;
  return {
    title: `Import ${input.format} collection “${name}”`,
    details: [
      `${countRequests(result.collection.items)} request(s)`,
      ...(scripts.length > 0 ? scripts : ['No scripts']),
    ],
    alwaysAsk: scripts.length > 0,
    // Imports mint fresh ids per parse; bind to the document itself.
    fingerprint: fingerprint(['import', input.format, input.content, input.name]),
    run: async () => {
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
        undo: restoreCollection(undefined, collection.id),
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
    fingerprint: fingerprint(located.collection),
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
  // A file-backed collection is unlinked from its folder on delete; undo
  // could not re-link it, so it is offered without one and the card says so.
  const fileBacked = useFileCollectionStore.getState().getFileInfo(collection.id) !== undefined;
  const workflows = useWorkflowStore.getState().getWorkflowsByCollectionId(collection.id);
  return {
    title: `Delete collection “${collection.name}”`,
    details: [
      `${countRequests(collection.items)} request(s) will be removed`,
      ...(workflows.length > 0 ? [`${workflows.length} workflow(s) will be removed`] : []),
      ...(fileBacked ? ['Linked to a folder on disk: this cannot be undone in Restura'] : []),
    ],
    fingerprint: fingerprint([collection, workflows, fileBacked]),
    run: async () => {
      const snapshot = structuredClone(collection);
      const savedWorkflows = structuredClone(workflows);
      const result = await deleteCollectionWithCleanup(collection.id);
      if (!result.success) throw new Error(result.error ?? 'Delete failed');
      const restore = restoreCollection(snapshot);
      return {
        data: { deleted: collection.id },
        summary: `Deleted collection “${collection.name}”`,
        ...(fileBacked
          ? {}
          : {
              undo: async () => {
                await restore();
                const store = useWorkflowStore.getState();
                for (const workflow of savedWorkflows) store.addWorkflow(workflow);
              },
            }),
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
  delete_item: deleteItem,
  delete_collection: deleteCollection,
} as const;
