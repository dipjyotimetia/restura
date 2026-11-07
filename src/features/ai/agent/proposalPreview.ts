/**
 * Human-readable previews of agent tool proposals, and Apply-with-Undo.
 *
 * The proposal card shows what a tool call would change on the active request
 * (old → new) instead of the raw tool JSON, and Apply returns an `undo` that
 * restores the request snapshot taken just before the tool ran. Nothing here
 * applies a change by itself: `applyAgentToolWithUndo` is only called from the
 * user's explicit Apply click (the propose-&-apply consent model is unchanged).
 */

import { useRequestStore } from '@/store/useRequestStore';
import type { HttpRequest, KeyValue, Request } from '@/types';
import { type AgentToolResult, runAgentTool } from './tools';

export interface ProposalChange {
  label: string;
  /** Absent → the field/entry is added. */
  before?: string;
  /** Absent → the field/entry is removed. */
  after?: string;
}

export interface ProposalPreview {
  title: string;
  changes: ProposalChange[];
}

const TOOL_TITLES: Record<string, string> = {
  create_http_request: 'Create a new request',
  set_test_script: 'Replace the test script',
  update_http_request: 'Update the active request',
  enrich_docs: 'Set the request documentation',
};

const PLACEHOLDER = '[REDACTED]';

function parse(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function pairs(v: unknown): Array<{ key: string; value: string }> | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.flatMap((p) => {
    const key = str((p as { key?: unknown } | null)?.key);
    const value = str((p as { value?: unknown } | null)?.value);
    return key !== undefined && value !== undefined ? [{ key, value }] : [];
  });
}

function diffField(
  out: ProposalChange[],
  label: string,
  before: string | undefined,
  after: string | undefined
): void {
  if (after === undefined || after.includes(PLACEHOLDER) || after === before) return;
  out.push(before ? { label, before, after } : { label, after });
}

/** Mirrors tools.ts mergeKeyValues: enabled rows matched by key; omitted rows are removed. */
function diffKeyValues(
  out: ProposalChange[],
  noun: string,
  current: readonly KeyValue[],
  proposed: Array<{ key: string; value: string }>,
  keyOf: (k: string) => string
): void {
  const pending = new Map<string, Array<{ key: string; value: string }>>();
  for (const p of proposed) {
    const k = keyOf(p.key);
    pending.set(k, [...(pending.get(k) ?? []), p]);
  }
  for (const row of current) {
    if (!row.enabled) continue;
    const match = pending.get(keyOf(row.key))?.shift();
    if (!match) out.push({ label: `${noun} ${row.key}`, before: row.value });
    else if (match.value !== row.value && !match.value.includes(PLACEHOLDER)) {
      out.push({ label: `${noun} ${row.key}`, before: row.value, after: match.value });
    }
  }
  for (const queue of pending.values()) {
    for (const p of queue) {
      if (!p.value.includes(PLACEHOLDER)) out.push({ label: `${noun} ${p.key}`, after: p.value });
    }
  }
}

/** Title + field-level before→after summary of a proposed tool call. */
export function describeProposal(
  name: string,
  rawInput: string,
  active: HttpRequest | null
): ProposalPreview {
  const title = TOOL_TITLES[name] ?? name;
  const input = parse(rawInput);
  const changes: ProposalChange[] = [];
  if (!input) return { title, changes };

  switch (name) {
    case 'create_http_request': {
      const method = (str(input.method) ?? 'GET').toUpperCase();
      diffField(changes, 'Request', undefined, `${method} ${str(input.url) ?? ''}`.trim());
      diffField(changes, 'Name', undefined, str(input.name));
      for (const h of pairs(input.headers) ?? [])
        changes.push({ label: `Header ${h.key}`, after: h.value });
      diffField(changes, 'Body', undefined, str(input.body));
      break;
    }
    case 'set_test_script':
      diffField(changes, 'Test script', active?.testScript, str(input.script));
      break;
    case 'enrich_docs':
      diffField(changes, 'Documentation', active?.description, str(input.documentation));
      break;
    case 'update_http_request': {
      const method = str(input.method);
      diffField(changes, 'Method', active?.method, method?.toUpperCase());
      diffField(changes, 'URL', active?.url, str(input.url));
      diffField(changes, 'Name', active?.name, str(input.name));
      const headers = pairs(input.headers);
      if (headers) {
        diffKeyValues(changes, 'Header', active?.headers ?? [], headers, (k) =>
          k.trim().toLowerCase()
        );
      }
      const params = pairs(input.params);
      if (params) diffKeyValues(changes, 'Param', active?.params ?? [], params, (k) => k.trim());
      diffField(changes, 'Body', active?.body.raw, str(input.body));
      break;
    }
  }
  return { title, changes };
}

/** Fields the active-request tools can change; restored as a unit on Undo. */
const RESTORED_FIELDS = [
  'method',
  'url',
  'name',
  'headers',
  'params',
  'body',
  'testScript',
  'description',
] as const;

/**
 * Run a tool (on the user's Apply) and return an `undo` that reverts it:
 * restores the active request's prior fields, or closes the tab a
 * create_http_request opened. No undo is returned when the tool failed.
 */
export function applyAgentToolWithUndo(
  name: string,
  rawInput: string
): { result: AgentToolResult; undo?: () => void } {
  const st = useRequestStore.getState();
  const tabId = st.activeTabId;
  const tab = st.tabs.find((t) => t.id === tabId);
  const snapshot: Partial<HttpRequest> | null =
    tab?.request.type === 'http'
      ? Object.fromEntries(
          RESTORED_FIELDS.map((f) => [f, structuredClone((tab.request as HttpRequest)[f])])
        )
      : null;

  const result = runAgentTool(name, rawInput);
  if (!result.ok) return { result };

  if (name === 'create_http_request') {
    const openedTabId = useRequestStore.getState().activeTabId;
    if (!openedTabId || openedTabId === tabId) return { result };
    return {
      result,
      undo: () => {
        if (useRequestStore.getState().tabs.some((t) => t.id === openedTabId)) {
          useRequestStore.getState().closeTab(openedTabId);
        }
      },
    };
  }
  if (!tabId || !snapshot) return { result };
  return {
    result,
    undo: () => {
      useRequestStore.getState().updateRequestForTab(tabId, snapshot as Partial<Request>);
    },
  };
}
