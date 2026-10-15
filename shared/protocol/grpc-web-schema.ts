import { z } from 'zod';
import { GRPC_PROXY_MAX_TIMEOUT_MS } from './grpc-schema';
import { MAX_GRPC_WEB_REQUEST_BYTES } from './grpc-web-proxy';

const MAX_METADATA_ENTRIES = 128;
const MAX_METADATA_VALUE_CHARS = 8 * 1024;

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
  metadata: z
    .record(z.string().max(256), z.string().max(MAX_METADATA_VALUE_CHARS))
    .refine((m) => Object.keys(m).length <= MAX_METADATA_ENTRIES, {
      message: `metadata is limited to ${MAX_METADATA_ENTRIES} entries`,
    })
    .optional(),
  // base64 inflates by 4/3; the decoded-size cap is re-checked in the core.
  message: z.string().max(Math.ceil((MAX_GRPC_WEB_REQUEST_BYTES * 4) / 3) + 4),
  timeout: z.number().int().min(0).max(GRPC_PROXY_MAX_TIMEOUT_MS).optional(),
  format: z.enum(['binary', 'text']).optional(),
});

export type GrpcWebProxyRequestBody = z.infer<typeof GrpcWebProxyRequestBodySchema>;
