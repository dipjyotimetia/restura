import { z } from 'zod';

/**
 * Zod schemas for the JSON bodies POSTed to `/api/grpc` and
 * `/api/grpc/reflection`. These run inside `parseJsonBody` at the Worker
 * boundary so a malformed payload returns a structured 400 instead of
 * landing in `executeGrpcProxy` or `sendReflectionRequest` and surfacing
 * as a 5xx.
 *
 * The shapes mirror `GrpcSpec` from `./grpc-proxy.ts` and the
 * `ReflectionRequest` interface in `worker/handlers/grpc-reflection.ts`.
 */

/** Mirrors `GrpcSpec` in `./grpc-proxy.ts`. Guarded by `tests/grpc-spec-parity.test.ts`. */
export const GrpcProxyRequestBodySchema = z.object({
  url: z.string().min(1),
  service: z.string().min(1),
  method: z.string().min(1),
  metadata: z.record(z.string(), z.string()).optional(),
  // `message` is opaque to the schema — the grpc handler passes it through to
  // `executeGrpcProxy`, which JSON-stringifies it before sending to Connect.
  // We accept `unknown` so the renderer can send any JSON-serialisable value.
  message: z.unknown().optional(),
  timeout: z.number().int().min(0).max(300_000).optional(),
});

export type GrpcProxyRequestBody = z.infer<typeof GrpcProxyRequestBodySchema>;

/** Per-entry cap (key + value bytes) — mirrors the renderer's call-path limit. */
export const GRPC_REFLECTION_METADATA_MAX_ENTRY_BYTES = 1024;
/** Total cap across all entries — mirrors the renderer's call-path limit. */
export const GRPC_REFLECTION_METADATA_MAX_TOTAL_BYTES = 8 * 1024;
// RFC 9110 field-name token; values may not carry CR/LF/NUL (header injection).
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE_RE = /^[^\r\n\0]*$/;

/**
 * Request metadata sent with a reflection query (#887), so reflection behind
 * an auth gateway works. Size-capped and token-validated at both boundaries
 * (Worker body + Electron IPC); hop-by-hop / proxy headers are then dropped by
 * `sanitizeRequestHeaders` where the request is built.
 */
export const GrpcReflectionMetadataSchema = z
  .record(
    z.string().regex(HEADER_NAME_RE, 'Invalid metadata key'),
    z.string().regex(HEADER_VALUE_RE, 'Metadata values must not contain CR, LF or NUL')
  )
  .superRefine((metadata, ctx) => {
    let total = 0;
    for (const [key, value] of Object.entries(metadata)) {
      const size = key.length + value.length;
      if (size > GRPC_REFLECTION_METADATA_MAX_ENTRY_BYTES) {
        ctx.addIssue({
          code: 'custom',
          message: `Metadata '${key}' exceeds ${GRPC_REFLECTION_METADATA_MAX_ENTRY_BYTES} bytes`,
        });
      }
      total += size;
    }
    if (total > GRPC_REFLECTION_METADATA_MAX_TOTAL_BYTES) {
      ctx.addIssue({
        code: 'custom',
        message: `Total metadata exceeds ${GRPC_REFLECTION_METADATA_MAX_TOTAL_BYTES} bytes`,
      });
    }
  });

/** Body of `/api/grpc/reflection` (see `./grpc-reflection-proxy.ts`). */
export const GrpcReflectionRequestBodySchema = z.object({
  url: z.string().min(1),
  request: z.object({
    listServices: z.string().optional(),
    fileContainingSymbol: z.string().optional(),
    fileByFilename: z.string().optional(),
  }),
  metadata: GrpcReflectionMetadataSchema.optional(),
  timeout: z.number().int().min(0).max(300_000).optional(),
});

export type GrpcReflectionRequestBody = z.infer<typeof GrpcReflectionRequestBodySchema>;
