import { z } from 'zod';
import { keyValueSchema } from './key-value';

/**
 * Zod schemas for saved WebSocket / Socket.IO connections (#1209) — see
 * `shared/types/stream-preset.ts`. Objects use Zod's default key stripping, so
 * unknown keys on an imported or persisted item are dropped on validation.
 */

const wsFormatSchema = z.enum(['text', 'json', 'hex']);
const nonNegInt = z.number().int().nonnegative();

const wsMessageSchema = z.object({ body: z.string(), format: wsFormatSchema });

export const webSocketRequestSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Name is required'),
  type: z.literal('websocket'),
  description: z.string().optional(),
  url: z.string(),
  protocols: z.array(z.string()),
  headers: z.array(keyValueSchema),
  message: wsMessageSchema,
  templates: z.array(wsMessageSchema.extend({ name: z.string() })),
  options: z
    .object({
      autoReconnect: z.boolean().optional(),
      maxReconnectAttempts: nonNegInt.optional(),
      reconnectDelay: nonNegInt.optional(),
      heartbeatInterval: nonNegInt.optional(),
      heartbeatMessage: z.string().optional(),
      perMessageDeflate: z.boolean().optional(),
    })
    .optional(),
  frameAssertion: z.object({ enabled: z.boolean(), script: z.string() }).optional(),
});

const sioEmitSchema = z.object({ eventName: z.string(), args: z.string(), ack: z.boolean() });

export const socketIoRequestSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Name is required'),
  type: z.literal('socketio'),
  description: z.string().optional(),
  url: z.string(),
  namespace: z.string(),
  path: z.string(),
  handshakeAuth: z.array(keyValueSchema),
  query: z.array(keyValueSchema),
  headers: z.array(keyValueSchema),
  transports: z.array(z.enum(['websocket', 'polling'])),
  subscribedEvents: z.array(z.string()),
  emit: sioEmitSchema,
  templates: z.array(sioEmitSchema.extend({ name: z.string() })),
  options: z
    .object({
      autoReconnect: z.boolean().optional(),
      reconnectionAttempts: nonNegInt.optional(),
      reconnectionDelay: nonNegInt.optional(),
      timeout: nonNegInt.optional(),
      forceNew: z.boolean().optional(),
    })
    .optional(),
});
