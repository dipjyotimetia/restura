// Socket.IO IPC schemas (`socketio:*`). Split out of core.ts (size cap).
import { z } from 'zod';
import { ConnectionIdSchema } from './core';

// ===========================
// Socket.IO Schemas
// ===========================

// Hop-by-hop and security-sensitive headers that must not be forwarded to
// arbitrary Socket.IO servers via extraHeaders.
const SOCKETIO_HEADER_DENYLIST = new Set([
  'host',
  'origin',
  'connection',
  'upgrade',
  'transfer-encoding',
  'te',
  'proxy-authorization',
  'proxy-connection',
  'sec-websocket-key',
  'sec-websocket-version',
]);

export const SocketIoConnectionIdSchema = ConnectionIdSchema;

const SOCKETIO_MAX_AUTH_BYTES = 64 * 1024;

function jsonByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export const SocketIoConnectSchema = z.object({
  connectionId: SocketIoConnectionIdSchema,
  url: z
    .string()
    .url('Invalid Socket.IO URL')
    .refine((url) => ['http:', 'https:', 'ws:', 'wss:'].includes(new URL(url).protocol), {
      message: 'Only http(s) and ws(s) Socket.IO URLs are allowed',
    }),
  namespace: z
    .string()
    .regex(/^\/[A-Za-z0-9/_-]*$/, 'Namespace must start with / and contain only safe characters')
    .optional(),
  path: z.string().startsWith('/', 'Path must start with /').optional(),
  // Any JSON-serialisable object (nested auth, numbers, booleans) — SIO-4.
  auth: z
    .record(z.string(), z.unknown())
    .refine((auth) => jsonByteLength(auth) <= SOCKETIO_MAX_AUTH_BYTES, {
      message: `Handshake auth must serialise to at most ${SOCKETIO_MAX_AUTH_BYTES} bytes of JSON`,
    })
    .optional(),
  query: z.record(z.string(), z.string()).optional(),
  extraHeaders: z
    .record(z.string(), z.string())
    .refine(
      (headers) => !Object.keys(headers).some((k) => SOCKETIO_HEADER_DENYLIST.has(k.toLowerCase())),
      {
        message: `Headers must not include hop-by-hop or security-sensitive fields: ${[...SOCKETIO_HEADER_DENYLIST].join(', ')}`,
      }
    )
    .optional(),
  transports: z
    .array(z.enum(['websocket', 'polling']))
    .min(1)
    .optional(),
  reconnection: z.boolean().optional(),
  reconnectionAttempts: z.number().int().nonnegative().max(100).optional(),
  reconnectionDelay: z.number().int().nonnegative().max(60_000).optional(),
  reconnectionDelayMax: z.number().int().nonnegative().max(300_000).optional(),
  randomizationFactor: z.number().min(0).max(1).optional(),
  timeout: z.number().int().positive().max(120_000).optional(),
  forceNew: z.boolean().optional(),
});

export const SocketIoEmitSchema = z.object({
  connectionId: SocketIoConnectionIdSchema,
  eventName: z.string().min(1).max(256),
  args: z.array(z.unknown()).max(32),
  ackId: z.string().min(1).max(128).optional(),
  ackTimeoutMs: z.number().int().positive().max(60_000).optional(),
  volatile: z.boolean().optional(),
  compress: z.boolean().optional(),
});

/** Answer a server-requested acknowledgement (SIO-1). */
export const SocketIoReplyAckSchema = z.object({
  connectionId: SocketIoConnectionIdSchema,
  serverAckId: z.string().min(1).max(128),
  args: z.array(z.unknown()).max(32),
});

export const SocketIoDisconnectSchema = z.object({
  connectionId: SocketIoConnectionIdSchema,
});

export type SocketIoConnectConfig = z.infer<typeof SocketIoConnectSchema>;
export type SocketIoEmitConfig = z.infer<typeof SocketIoEmitSchema>;
export type SocketIoDisconnectConfig = z.infer<typeof SocketIoDisconnectSchema>;
export type SocketIoReplyAckConfig = z.infer<typeof SocketIoReplyAckSchema>;
