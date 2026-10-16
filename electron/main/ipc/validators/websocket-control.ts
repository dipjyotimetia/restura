import {
  closeFrameError,
  isSendableCloseCode,
  pingPayloadError,
  utf8ByteLength,
  WS_MAX_CLOSE_REASON_BYTES,
} from '@shared/protocol/websocket-control';
import { z } from 'zod';
import { WsConnectionIdSchema } from './core';

// ===========================
// WebSocket control-frame schemas (#915 close code/reason, #919 ping)
// ===========================

/**
 * Explicit disconnect. `code`/`reason` are optional; when present they are
 * validated per RFC 6455 (client-sendable codes 1000 / 3000-4999, reason at
 * most 123 UTF-8 bytes, reason only alongside a code).
 */
export const WsDisconnectSchema = z
  .object({
    connectionId: WsConnectionIdSchema,
    code: z
      .number()
      .refine(isSendableCloseCode, { message: 'Close code must be 1000 or 3000-4999' })
      .optional(),
    reason: z
      .string()
      .refine((r) => utf8ByteLength(r) <= WS_MAX_CLOSE_REASON_BYTES, {
        message: `Close reason must be at most ${WS_MAX_CLOSE_REASON_BYTES} bytes (UTF-8)`,
      })
      .optional(),
  })
  .refine((v) => closeFrameError(v.code, v.reason) === null, {
    message: 'A close reason requires a close code',
    path: ['reason'],
  });

/** Desktop-only Ping control frame; payload is UTF-8 text, ≤125 bytes. */
export const WsPingSchema = z.object({
  connectionId: WsConnectionIdSchema,
  payload: z
    .string()
    .refine((p) => pingPayloadError(p) === null, {
      message: 'Ping payload must be at most 125 bytes (UTF-8)',
    })
    .optional(),
});

export type WsDisconnectConfig = z.infer<typeof WsDisconnectSchema>;
export type WsPingConfig = z.infer<typeof WsPingSchema>;
