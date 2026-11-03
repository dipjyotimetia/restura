/**
 * Contract between the control-tool runtime and each tool implementation.
 *
 * A tool is two-phase so consent is checked, the user sees exactly what will
 * happen, and consent is checked AGAIN right before anything changes (the user
 * may revoke access while an approval card is open):
 *
 *   prepare(input) → refusal | { title, details, fingerprint, run }
 *   [approval / secret prompt, per tier + approval mode]
 *   prepare(input) again → same fingerprint? → run()
 *
 * The fingerprint binds an approval to the state the user saw: if the target
 * (or anything a send depends on — the request, its collection, the
 * environment chain, globals) changed while the card was open, the call is
 * refused rather than run against something the user did not approve.
 */

import { MAX_AGENT_SCRIPT_CHARS } from '@shared/mcp-server/control-tools';
import type { McpServerSettings } from '@shared/mcp-server/settings';

export interface ToolEnv {
  settings: McpServerSettings;
  /** Display-only client label. */
  client?: string;
  /** Aborted when the agent cancels or the server stops. */
  signal: AbortSignal;
}

export interface ToolOutcome {
  /** Agent-visible result (already redacted by the tool). */
  data: unknown;
  /** One line for the activity log. */
  summary: string;
  /** Reverts the change. Present on edit/destructive tools that can be undone. */
  undo?: () => void | Promise<void>;
}

export interface SecretPromptSpec {
  environmentName: string;
  key: string;
  reason: string;
}

export interface PreparedCall {
  /** Approval card title, e.g. "Create request “List orders”". */
  title: string;
  /** Approval card lines: target collection, method + URL, environment, … */
  details: string[];
  /** When set, the user types a secret instead of clicking Approve. */
  secretPrompt?: SecretPromptSpec;
  /**
   * Ask even in auto-approve-edits mode — e.g. the change adds or alters a
   * pre-request / test script, which runs with full script powers on the
   * next send.
   */
  alwaysAsk?: boolean;
  /** Snapshot of the state this call depends on. Defaults to title + details. */
  fingerprint?: string;
  run: (extra: { secretValue?: string }) => Promise<ToolOutcome> | ToolOutcome;
}

export interface ToolRefusal {
  refused: string;
}

export type PrepareResult = PreparedCall | ToolRefusal;

export type ToolImpl<I = never> = (
  input: I,
  env: ToolEnv
) => PrepareResult | Promise<PrepareResult>;

/** Long values shown on an approval card are cut here (scripts get more room). */
export const DETAIL_VALUE_CHARS = 400;
export const DETAIL_SCRIPT_CHARS = MAX_AGENT_SCRIPT_CHARS;

export function clip(value: string, max = DETAIL_VALUE_CHARS): string {
  return value.length > max
    ? `${value.slice(0, max)}… (${value.length - max} more characters)`
    : value;
}

/** Card lines that show a script in full, so the user approves the code itself. */
export function scriptDetails(label: string, script: string | undefined): string[] {
  if (script === undefined || script.trim() === '') return [];
  return [`${label} (runs on every send):\n${clip(script, DETAIL_SCRIPT_CHARS)}`];
}

export function refuse(message: string): ToolRefusal {
  return { refused: message };
}

export function isRefusal(value: PrepareResult): value is ToolRefusal {
  return 'refused' in value;
}

/** Shared wording so the agent can tell the user exactly where to grant access. */
export const SETTINGS_HINT = 'Ask the user to grant it in Restura → Settings → MCP Server.';
