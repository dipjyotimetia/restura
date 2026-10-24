import { z } from 'zod';

// ===========================
// MCP config import (#906) - desktop only
// ===========================

/**
 * `mcp:import:scan`. There is deliberately NO path field: main reads either
 * the fixed list of well-known client config locations or a file the user
 * picks in a main-owned native dialog. A renderer cannot name a file.
 */
export const McpImportScanSchema = z.object({ source: z.enum(['detect', 'pick']) }).strict();

const SelectionKey = z.string().regex(/^\d{1,3}\.\d{1,4}$/);

/** `mcp:import:commit`: a scan session id plus the selection keys the user ticked. */
export const McpImportCommitSchema = z
  .object({
    sessionId: z.string().uuid(),
    keys: z.array(SelectionKey).min(1).max(200),
  })
  .strict();

export type McpImportScanInput = z.infer<typeof McpImportScanSchema>;
export type McpImportCommitInput = z.infer<typeof McpImportCommitSchema>;
