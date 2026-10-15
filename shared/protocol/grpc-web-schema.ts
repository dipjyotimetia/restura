import { z } from 'zod';
import { GRPC_PROXY_MAX_TIMEOUT_MS } from './grpc-schema';
import { MAX_GRPC_WEB_REQUEST_BYTES } from './grpc-web-proxy';

export const MAX_GRPC_WEB_METADATA_ENTRIES = 128;
export const MAX_GRPC_WEB_METADATA_KEY_CHARS = 256;
export const MAX_GRPC_WEB_METADATA_VALUE_CHARS = 8 * 1024;
// base64 inflates by 4/3; the decoded-size cap is re-checked in the core.
export const MAX_GRPC_WEB_MESSAGE_FIELD_CHARS = Math.ceil((MAX_GRPC_WEB_REQUEST_BYTES * 4) / 3) + 4;

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
    .record(
      z.string().max(MAX_GRPC_WEB_METADATA_KEY_CHARS),
      z.string().max(MAX_GRPC_WEB_METADATA_VALUE_CHARS)
    )
    .refine((m) => Object.keys(m).length <= MAX_GRPC_WEB_METADATA_ENTRIES, {
      message: `metadata is limited to ${MAX_GRPC_WEB_METADATA_ENTRIES} entries`,
    })
    .optional(),
  message: z.string().max(MAX_GRPC_WEB_MESSAGE_FIELD_CHARS),
  timeout: z.number().int().min(0).max(GRPC_PROXY_MAX_TIMEOUT_MS).optional(),
  format: z.enum(['binary', 'text']).optional(),
});

export type GrpcWebProxyRequestBody = z.infer<typeof GrpcWebProxyRequestBodySchema>;
