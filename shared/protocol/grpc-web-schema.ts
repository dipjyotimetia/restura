import { z } from 'zod';
import { MAX_GRPC_WEB_REQUEST_BYTES } from './grpc-web-proxy';

/**
 * Zod schema for the JSON body POSTed to `/api/grpc-web`. Mirrors
 * `GrpcWebSpec` in `./grpc-web-proxy.ts` (parity guarded by
 * `grpc-web-proxy.test.ts`). Runs inside `parseJsonBody` at the Worker
 * boundary so a malformed payload is a structured 400.
 */
export const GrpcWebProxyRequestBodySchema = z.object({
  url: z.string().min(1),
  service: z.string().min(1),
  method: z.string().min(1),
  metadata: z.record(z.string(), z.string()).optional(),
  // base64 inflates by 4/3; the decoded-size cap is re-checked in the core.
  message: z.string().max(Math.ceil((MAX_GRPC_WEB_REQUEST_BYTES * 4) / 3) + 4),
  timeout: z.number().int().min(0).max(300_000).optional(),
  format: z.enum(['binary', 'text']).optional(),
});

export type GrpcWebProxyRequestBody = z.infer<typeof GrpcWebProxyRequestBodySchema>;
