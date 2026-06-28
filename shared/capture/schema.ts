/**
 * Zod schemas for the capture data model — the single source of truth for both
 * the static types (re-exported from `types.ts` via `z.infer`) and runtime
 * validation at trust boundaries. The Electron desktop bridge ingests a
 * `CaptureSession` as untrusted JSON over a loopback socket, so it MUST validate
 * with `captureSessionSchema` before doing anything with the payload.
 *
 * Bounds are deliberately generous but finite (defence against a hostile or
 * buggy producer flooding the bridge).
 */
import { z } from 'zod';

/** ~8 MB per textual body; base64 inflates ~4/3 so the cap leaves headroom. */
const MAX_BODY_CHARS = 8 * 1024 * 1024;

export const capturedProtocolSchema = z.enum(['rest', 'graphql', 'grpc-web', 'websocket', 'sse']);

export const capturedHeaderSchema = z.object({
  name: z.string().max(1024),
  value: z.string().max(64 * 1024),
});

export const capturedBodySchema = z.object({
  text: z.string().max(MAX_BODY_CHARS).optional(),
  base64: z.string().max(MAX_BODY_CHARS).optional(),
  mimeType: z.string().max(256).optional(),
  truncated: z.boolean().optional(),
});

export const capturedFrameSchema = z.object({
  direction: z.enum(['sent', 'received']),
  opcode: z.number().int().optional(),
  payload: capturedBodySchema,
  at: z.number(),
});

export const capturedGraphqlSchema = z.object({
  operationName: z.string().max(1024).optional(),
  operationType: z.enum(['query', 'mutation', 'subscription']).optional(),
});

export const capturedExchangeSchema = z.object({
  id: z.string().min(1).max(256),
  protocol: capturedProtocolSchema,
  method: z.string().min(1).max(16),
  url: z.string().max(64 * 1024),
  startedAt: z.number(),
  request: z.object({
    headers: z.array(capturedHeaderSchema).max(1000),
    body: capturedBodySchema.optional(),
  }),
  response: z
    .object({
      status: z.number().int().min(0).max(599),
      statusText: z.string().max(1024).optional(),
      headers: z.array(capturedHeaderSchema).max(1000),
      body: capturedBodySchema.optional(),
    })
    .optional(),
  frames: z.array(capturedFrameSchema).max(100_000).optional(),
  graphql: capturedGraphqlSchema.optional(),
});

export const captureSessionSchema = z.object({
  id: z.string().min(1).max(256),
  createdAt: z.number(),
  origin: z.string().max(2048).optional(),
  exchanges: z.array(capturedExchangeSchema).max(50_000),
});
