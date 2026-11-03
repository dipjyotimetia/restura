/**
 * Contract between the control-tool runtime and each tool implementation.
 *
 * A tool is two-phase so consent is checked, the user sees exactly what will
 * happen, and consent is checked AGAIN right before anything changes (the user
 * may revoke access while an approval card is open):
 *
 *   prepare(input) → refusal | { title, details, run }
 *   [approval / secret prompt, per tier + approval mode]
 *   prepare(input) again → run()
 */

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
  run: (extra: { secretValue?: string }) => Promise<ToolOutcome> | ToolOutcome;
}

export interface ToolRefusal {
  refused: string;
}

export type PrepareResult = PreparedCall | ToolRefusal;

export type ToolImpl<I = never> = (input: I, env: ToolEnv) => PrepareResult;

export function refuse(message: string): ToolRefusal {
  return { refused: message };
}

export function isRefusal(value: PrepareResult): value is ToolRefusal {
  return 'refused' in value;
}

/** Shared wording so the agent can tell the user exactly where to grant access. */
export const SETTINGS_HINT = 'Ask the user to grant it in Restura → Settings → MCP Server.';
