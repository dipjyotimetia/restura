/**
 * Persisted MCP control-server settings (`AppSettings.mcpServer`).
 *
 * Lives in `shared/` because three layers read the same shape: the renderer
 * settings store (persist + validate on rehydrate), the renderer tool runtime
 * (consent + approval gate), and tests. Electron main never reads it — main
 * only hosts the transport; every policy decision happens in the renderer that
 * owns the data (ADR 0041).
 */

import { z } from 'zod';
import { DEFAULT_CONSENT, McpServerConsentSchema } from './consent';

/**
 * How tool calls that change or send things are approved.
 *
 * - `ask-every-change` (default): every edit, delete and send waits for the
 *   user to click Approve in Restura.
 * - `auto-approve-edits`: create/update/move tool calls apply immediately (and
 *   are listed in the activity log, with Undo); deletes and sends still ask.
 *
 * There is intentionally no mode that auto-approves deletes or sends.
 */
export const McpApprovalModeSchema = z.enum(['ask-every-change', 'auto-approve-edits']);
export type McpApprovalMode = z.infer<typeof McpApprovalModeSchema>;

export const McpServerSettingsSchema = z.object({
  /** Whether the desktop app should host the control server. Off by default. */
  enabled: z.boolean(),
  approvalMode: McpApprovalModeSchema,
  consent: McpServerConsentSchema,
  /**
   * Redact token-like fields (access_token, password, …) and credential
   * headers from response bodies before an agent sees them. On by default;
   * turning it off is an explicit choice for debugging auth flows.
   */
  redactResponseBodies: z.boolean(),
  /** Preferred loopback port. Absent = reuse the last port, else a random one. */
  preferredPort: z.number().int().min(1024).max(65535).optional(),
  /**
   * When these settings last changed (ms since epoch). Each app window holds
   * its own in-memory copy; the newest copy — in memory or persisted — wins,
   * so a change made in one window reaches the window running the server.
   */
  updatedAt: z.number().optional(),
});
export type McpServerSettings = z.infer<typeof McpServerSettingsSchema>;

export const DEFAULT_MCP_SERVER_SETTINGS: McpServerSettings = {
  enabled: false,
  approvalMode: 'ask-every-change',
  consent: DEFAULT_CONSENT,
  redactResponseBodies: true,
};

/**
 * Rehydrate-time parse: never throws, falls back per field. A corrupt consent
 * blob falls back to DEFAULT_CONSENT (everything hidden) — fail closed.
 */
export const McpServerSettingsCatchSchema = z.object({
  enabled: z.boolean().catch(false),
  approvalMode: McpApprovalModeSchema.catch('ask-every-change'),
  consent: McpServerConsentSchema.catch(DEFAULT_CONSENT),
  redactResponseBodies: z.boolean().catch(true),
  preferredPort: z.number().int().min(1024).max(65535).optional().catch(undefined),
  updatedAt: z.number().optional().catch(undefined),
});
