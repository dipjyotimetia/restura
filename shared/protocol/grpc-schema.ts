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

/** Mirrors the `ReflectionRequest` interface in `worker/handlers/grpc-reflection.ts`. */
export const GrpcReflectionRequestBodySchema = z.object({
  url: z.string().min(1),
  request: z.object({
    listServices: z.string().optional(),
    fileContainingSymbol: z.string().optional(),
  }),
  timeout: z.number().int().min(0).max(300_000).optional(),
});

export type GrpcReflectionRequestBody = z.infer<typeof GrpcReflectionRequestBodySchema>;
