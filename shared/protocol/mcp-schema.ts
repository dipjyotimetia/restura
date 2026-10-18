import { z } from 'zod';
import { isMcpNotificationMethod } from './mcp-version';

/**
 * Zod schema for the JSON body POSTed to `/api/mcp`. Mirrors the
 * `McpSpec` interface in `./mcp-proxy.ts`. The Worker handler used to
 * validate `url` ad-hoc and rely on `validateMcpSpec` for the rest; this
 * schema centralises the boundary check so a malformed body returns a
 * structured 400 before `validateMcpSpec` is reached.
 *
 * `transport` is kept open to `z.string()` here so the Worker handler's
 * existing 400 message from `validateMcpSpec` (with its precise
 * "expected ..." wording) keeps surfacing for the common case of a wrong
 * transport string. Tightening to `z.enum([...])` would shift that
 * branch's error message to a generic Zod one and break consumer
 * expectations.
 */
export const McpRequestBodySchema = z.object({
  url: z.string().min(1),
  transport: z.string().min(1),
  postEndpoint: z.string().optional(),
  sessionId: z.string().optional(),
  protocolVersion: z.string().max(64).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  jsonRpc: z
    .object({
      method: z.string().min(1),
      params: z.unknown().optional(),
      // Omitted only for JSON-RPC notifications (`notifications/*`), e.g.
      // the mandatory `notifications/initialized` after `initialize` (#862).
      id: z.union([z.string(), z.number()]).optional(),
    })
    .refine((rpc) => rpc.id !== undefined || isMcpNotificationMethod(rpc.method), {
      message: 'id is required for requests (only notifications/* may omit it)',
      path: ['id'],
    }),
  timeout: z.number().int().min(0).max(300_000).optional(),
});

export type McpRequestBody = z.infer<typeof McpRequestBodySchema>;
