import {
  McpConfigParseError,
  type ParsedMcpEntry,
  parseMcpConfigText,
} from '@shared/mcp-import/mcp-config-parser';
import {
  buildHttpDraft,
  type McpImportDraft,
  type McpImportPreviewSource,
  toPreviewEntry,
} from '@shared/mcp-import/mcp-import-model';
import { v4 as uuidv4 } from 'uuid';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { KeyValue, McpRequest, McpStdioEnvVar } from '@/types';

export const MCP_IMPORT_COLLECTION_NAME = 'Imported MCP servers';

/**
 * Web / paste path (#906): parse in the renderer and keep the parsed entries
 * locally. Only HTTP entries can be created here; stdio rows are previewed as
 * desktop-only. Desktop never uses this: main reads the files and returns a
 * preview with secret env values omitted (see mcp-import-handler.ts).
 */
export function scanPastedConfig(
  text: string,
  label: string
): { source: McpImportPreviewSource; entries: Map<string, ParsedMcpEntry> } {
  const entries = new Map<string, ParsedMcpEntry>();
  try {
    const parsed = parseMcpConfigText(text);
    for (const entry of parsed.entries) entries.set(`0.${entry.key}`, entry);
    return {
      entries,
      source: {
        label,
        location: '',
        formats: parsed.formats,
        entries: parsed.entries.map((e) => toPreviewEntry(e, '0.', () => false)),
        inputs: parsed.inputs,
        warnings: parsed.warnings,
      },
    };
  } catch (err) {
    return {
      entries,
      source: {
        label,
        location: '',
        formats: [],
        entries: [],
        inputs: [],
        warnings: [],
        error: err instanceof McpConfigParseError ? err.message : 'Could not parse the config',
      },
    };
  }
}

/** HTTP drafts for the selected keys (web path). Stdio and invalid entries are skipped. */
export function webDraftsFor(entries: Map<string, ParsedMcpEntry>, keys: string[]) {
  const drafts: McpImportDraft[] = [];
  for (const key of keys) {
    const entry = entries.get(key);
    if (entry?.kind === 'http') drafts.push(buildHttpDraft(entry));
  }
  return drafts;
}

export function draftToMcpRequest(draft: McpImportDraft): McpRequest {
  const headers: KeyValue[] = draft.headers.map((h) => ({
    id: uuidv4(),
    key: h.key,
    value: h.value,
    enabled: true,
    ...(h.secret ? { secret: true } : {}),
  }));
  const request: McpRequest = {
    id: uuidv4(),
    name: draft.name,
    type: 'mcp',
    url: draft.url,
    transport: draft.transport,
    headers,
    auth: { type: 'none' },
  };
  if (draft.stdio) {
    const env: McpStdioEnvVar[] = draft.stdio.env.map((row) => ({
      id: uuidv4(),
      key: row.key,
      value: row.value,
      enabled: true,
      ...(row.secret ? { secret: true } : {}),
      ...(row.secretRef ? { secretRef: row.secretRef } : {}),
    }));
    request.stdio = {
      command: draft.stdio.command,
      args: draft.stdio.args,
      ...(draft.stdio.cwd !== undefined ? { cwd: draft.stdio.cwd } : {}),
      env,
    };
  }
  return request;
}

/** Save drafts as one collection of MCP requests. Nothing is connected or approved here. */
export function addDraftsAsCollection(drafts: McpImportDraft[]): string {
  const id = uuidv4();
  useCollectionStore.getState().addCollection({
    id,
    name: MCP_IMPORT_COLLECTION_NAME,
    items: drafts.map((draft) => {
      const request = draftToMcpRequest(draft);
      return { id: uuidv4(), name: draft.name, type: 'request' as const, request };
    }),
  });
  return id;
}
