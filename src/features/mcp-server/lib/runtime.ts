/**
 * The renderer-side MCP control-tool runtime (ADR 0041). Main forwards every
 * agent tool call here; this is where policy lives:
 *
 *   1. the server must be enabled in settings;
 *   2. the input is re-validated against the shared schema (main validated
 *      too — the renderer does not trust main's copy of the catalogue);
 *   3. the tool's `prepare` checks consent and describes the change;
 *   4. edits / deletes / sends wait for the user per tier + approval mode
 *      (secrets are typed by the user instead);
 *   5. settings and consent are re-read and `prepare` runs again right before
 *      `run` — revoking access while a card is open takes effect;
 *   6. the result is deep-redacted once more and the call is logged, with an
 *      Undo for reversible changes.
 */

import {
  APPROVAL_TIMEOUT_MS,
  type ControlToolResult,
  type ToolCallEvent,
} from '@shared/mcp-server/control-bridge';
import {
  type ControlToolDefinition,
  type ControlToolName,
  getControlTool,
  type ToolTier,
} from '@shared/mcp-server/control-tools';
import { postProcessResult } from '@shared/mcp-server/dispatch';
import type { McpApprovalMode, McpServerSettings } from '@shared/mcp-server/settings';
import { v4 as uuidv4 } from 'uuid';
import {
  type ActivityEntry,
  type ActivityStatus,
  enqueueApproval,
  enqueueSecretPrompt,
  settleAllPending,
  settleApproval,
  settleSecretPrompt,
  useMcpServerRuntimeStore,
} from '../store/useMcpServerRuntimeStore';
import { getFreshMcpServerSettings } from './settings';
import { EDIT_TOOLS } from './tools/editTools';
import { ENVIRONMENT_TOOLS } from './tools/environmentTools';
import { EXECUTE_TOOLS } from './tools/executeTools';
import { READ_TOOLS } from './tools/readTools';
import { isRefusal, type PreparedCall, type ToolEnv, type ToolImpl } from './tools/types';

// biome-ignore lint/suspicious/noExplicitAny: each impl is typed against its own schema; the runtime parses first
type AnyToolImpl = ToolImpl<any>;

/** Every catalogue tool has exactly one implementation (compile-time checked). */
export const TOOL_IMPLEMENTATIONS = {
  ...READ_TOOLS,
  ...EDIT_TOOLS,
  ...ENVIRONMENT_TOOLS,
  ...EXECUTE_TOOLS,
} satisfies Record<ControlToolName, AnyToolImpl>;

const implementations: Record<string, AnyToolImpl> = TOOL_IMPLEMENTATIONS;

export function needsApproval(tier: ToolTier, mode: McpApprovalMode): boolean {
  switch (tier) {
    case 'read':
    case 'ui':
      return false;
    case 'edit':
      return mode !== 'auto-approve-edits';
    case 'destructive':
    case 'execute':
      return true;
  }
}

const inFlight = new Map<string, AbortController>();
const undoActions = new Map<string, () => void | Promise<void>>();

function clientLabel(event: ToolCallEvent): string | undefined {
  if (!event.client) return undefined;
  return event.client.version ? `${event.client.name} ${event.client.version}` : event.client.name;
}

function log(
  event: ToolCallEvent,
  tier: ToolTier,
  status: ActivityStatus,
  summary: string,
  extra: { detail?: string; undo?: () => void | Promise<void> } = {}
): void {
  const entry: ActivityEntry = {
    id: uuidv4(),
    at: Date.now(),
    tool: event.tool,
    tier,
    summary,
    status,
    undoable: extra.undo !== undefined,
    ...(clientLabel(event) ? { client: clientLabel(event) } : {}),
    ...(extra.detail ? { detail: extra.detail } : {}),
  };
  if (extra.undo) undoActions.set(entry.id, extra.undo);
  useMcpServerRuntimeStore.getState().pushActivity(entry);
  // Bound the closures with the log.
  const live = new Set(useMcpServerRuntimeStore.getState().activity.map((e) => e.id));
  for (const id of undoActions.keys()) if (!live.has(id)) undoActions.delete(id);
}

function formatZodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  return error.issues
    .slice(0, 10)
    .map((i) => `${i.path.map(String).join('.') || '(input)'}: ${i.message}`)
    .join('; ');
}

function fingerprintOf(call: PreparedCall): string {
  return call.fingerprint ?? JSON.stringify([call.title, call.details]);
}

/** Error text for the agent, kept well under main's result-schema cap. */
export function boundedError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
}

const MAX_ERROR_CHARS = 2_000;

const DENIED: Record<'denied' | 'timeout' | 'cancelled', string> = {
  denied: 'The user denied this in Restura. Do not retry it unless they ask you to.',
  timeout: 'Nobody approved this in Restura in time, so it was not done.',
  cancelled: 'The call was cancelled before it was approved.',
};

export interface RunOptions {
  approvalTimeoutMs?: number;
}

/** Run one forwarded tool call to completion. Never throws. */
export async function runControlTool(
  event: ToolCallEvent,
  options: RunOptions = {}
): Promise<ControlToolResult> {
  const def = getControlTool(event.tool);
  const impl = implementations[event.tool];
  if (!def || !impl) return { ok: false, error: `Unknown tool: ${event.tool}` };

  // Register before the first await, so a cancel from main is never missed.
  const controller = new AbortController();
  inFlight.set(event.callId, controller);
  try {
    return await runRegistered(event, def, impl, controller, options);
  } finally {
    inFlight.delete(event.callId);
  }
}

async function runRegistered(
  event: ToolCallEvent,
  def: ControlToolDefinition,
  impl: AnyToolImpl,
  controller: AbortController,
  options: RunOptions
): Promise<ControlToolResult> {
  // Newest settings across windows: a change made in another window (access
  // revoked, server turned off) must apply here too.
  const settings = await getFreshMcpServerSettings();
  if (!settings.enabled) {
    return { ok: false, error: 'The Restura MCP server is turned off.' };
  }

  const parsed = def.inputSchema.safeParse(event.input);
  if (!parsed.success) {
    return { ok: false, error: `Invalid input: ${formatZodIssues(parsed.error)}` };
  }
  if (controller.signal.aborted) return { ok: false, error: DENIED.cancelled };

  const client = clientLabel(event);
  const envFor = (s: McpServerSettings): ToolEnv => ({
    settings: s,
    signal: controller.signal,
    ...(client ? { client } : {}),
  });

  try {
    const prepared = await impl(parsed.data, envFor(settings));
    if (isRefusal(prepared)) {
      if (def.tier !== 'read' && def.tier !== 'ui') {
        log(event, def.tier, 'refused', def.title, { detail: prepared.refused });
      }
      return { ok: false, error: prepared.refused };
    }
    // Cancelled while an async prepare (e.g. an import being parsed) ran:
    // never show a card or a secret prompt for a call nobody is waiting on.
    if (controller.signal.aborted) return { ok: false, error: DENIED.cancelled };

    let secretValue: string | undefined;
    const timeoutMs = options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
    if (prepared.secretPrompt) {
      const value = await enqueueSecretPrompt(
        {
          callId: event.callId,
          environmentName: prepared.secretPrompt.environmentName,
          key: prepared.secretPrompt.key,
          reason: prepared.secretPrompt.reason,
          createdAt: Date.now(),
          ...(client ? { client } : {}),
        },
        timeoutMs
      );
      if (value === null) {
        log(event, def.tier, 'denied', prepared.title, { detail: 'No value entered' });
        return {
          ok: false,
          error: 'The user did not enter a value. Do not ask them to paste it in the chat.',
        };
      }
      secretValue = value;
    } else if (prepared.alwaysAsk || needsApproval(def.tier, settings.approvalMode)) {
      const decision = await enqueueApproval(
        {
          callId: event.callId,
          tool: event.tool,
          tier: def.tier,
          title: prepared.title,
          details: prepared.details,
          createdAt: Date.now(),
          ...(client ? { client } : {}),
        },
        timeoutMs
      );
      if (decision !== 'approved') {
        log(
          event,
          def.tier,
          'denied',
          prepared.title,
          decision === 'denied' ? {} : { detail: decision === 'timeout' ? 'timed out' : decision }
        );
        return { ok: false, error: DENIED[decision] };
      }
    }

    // Time of use: re-read settings + consent and re-prepare.
    const fresh = await getFreshMcpServerSettings();
    if (!fresh.enabled) return { ok: false, error: 'The Restura MCP server is turned off.' };
    const current = await impl(parsed.data, envFor(fresh));
    if (isRefusal(current)) {
      log(event, def.tier, 'refused', prepared.title, { detail: current.refused });
      return { ok: false, error: current.refused };
    }
    if (fingerprintOf(current) !== fingerprintOf(prepared)) {
      // The target changed while the card was open (possibly by another
      // agent call): never run something other than what was approved.
      const detail = 'Changed while waiting for approval';
      log(event, def.tier, 'refused', prepared.title, { detail });
      return {
        ok: false,
        error:
          'What this call would change or send was modified while it waited for approval, so it was not run. Call it again so the user can review the current version.',
      };
    }
    if (controller.signal.aborted) return { ok: false, error: DENIED.cancelled };

    const outcome = await current.run(secretValue !== undefined ? { secretValue } : {});
    if (def.tier !== 'read') {
      log(event, def.tier, 'applied', outcome.summary, outcome.undo ? { undo: outcome.undo } : {});
    }
    // The one redaction entry point every result passes (main redacts again).
    return postProcessResult({ ok: true, data: outcome.data }) as ControlToolResult;
  } catch (err) {
    const message = boundedError(err);
    log(event, def.tier, 'failed', def.title, { detail: message });
    return { ok: false, error: controller.signal.aborted ? DENIED.cancelled : message };
  }
}

/** Main told us the call ended (agent cancelled / timeout / server stopped). */
export function cancelControlToolCall(callId: string): void {
  settleApproval(callId, 'cancelled');
  settleSecretPrompt(callId, null);
  inFlight.get(callId)?.abort();
}

export function cancelAllControlToolCalls(): void {
  settleAllPending();
  for (const controller of inFlight.values()) controller.abort();
}

export type UndoResult = { ok: true } | { ok: false; error: string };

/**
 * Revert one logged change. Refuses (and stays available) when the target
 * changed since — undoing would also discard the later changes; undo those
 * first. Never throws.
 */
export async function undoActivity(activityId: string): Promise<UndoResult> {
  const undo = undoActions.get(activityId);
  if (!undo) return { ok: false, error: 'This change can no longer be undone.' };
  try {
    await undo();
  } catch (err) {
    return { ok: false, error: boundedError(err) };
  }
  undoActions.delete(activityId);
  useMcpServerRuntimeStore
    .getState()
    .updateActivity(activityId, { status: 'undone', undoable: false });
  return { ok: true };
}
