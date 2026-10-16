/**
 * Saved message templates for streaming connections (#974 / #931).
 *
 * Templates live on the persisted connection model of each protocol store
 * (WebSocket, Socket.IO, MQTT). They are stored exactly as typed — `{{var}}`
 * tokens are resolved only at send time and the resolved text is never
 * written back here.
 *
 * The list helpers are pure and protocol-agnostic; the Zod schemas back the
 * persisted-store migration so a corrupt entry is dropped instead of breaking
 * rehydration of the whole connection.
 */

import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

export interface MessageTemplateBase {
  id: string;
  name: string;
}

export type WebSocketTemplateFormat = 'text' | 'json' | 'hex';

export interface WebSocketMessageTemplate extends MessageTemplateBase {
  body: string;
  format: WebSocketTemplateFormat;
}

export interface SocketIOEmitTemplate extends MessageTemplateBase {
  eventName: string;
  /** Raw JSON text as typed in the composer (a value or an array of args). */
  args: string;
  ack: boolean;
}

export interface MqttPublishTemplate extends MessageTemplateBase {
  topic: string;
  payload: string;
  qos: 0 | 1 | 2;
  retain: boolean;
  /** Optional MQTT 5 publish properties, carried through to `publish` when set. */
  contentType?: string;
  responseTopic?: string;
  userProperties?: Record<string, string>;
}

const base = { id: z.string().min(1), name: z.string() };

export const webSocketTemplateSchema = z.object({
  ...base,
  body: z.string(),
  format: z.enum(['text', 'json', 'hex']),
});

export const socketIOTemplateSchema = z.object({
  ...base,
  eventName: z.string(),
  args: z.string(),
  ack: z.boolean(),
});

export const mqttTemplateSchema = z.object({
  ...base,
  topic: z.string(),
  payload: z.string(),
  qos: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  retain: z.boolean(),
  contentType: z.string().optional(),
  responseTopic: z.string().optional(),
  userProperties: z.record(z.string(), z.string()).optional(),
});

/** Keep only entries that match `schema`; anything that isn't an array → []. */
export function sanitizeTemplates<T>(raw: unknown, schema: z.ZodType<T>): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    const parsed = schema.safeParse(entry);
    if (!parsed.success) continue;
    // Every template schema requires a string id; duplicates would break
    // rename/reorder/delete, so keep the first occurrence only.
    const { id } = parsed.data as { id: string };
    if (ids.has(id)) continue;
    ids.add(id);
    out.push(parsed.data);
  }
  return out;
}

/**
 * Persisted-store migration step body: give every persisted connection a
 * sanitized `templates` array. Shared by the three connection stores.
 */
export function migrateConnectionTemplates<T>(
  state: unknown,
  schema: z.ZodType<T>,
  extra?: (conn: Record<string, unknown>) => Record<string, unknown>
): unknown {
  if (!state || typeof state !== 'object') return state;
  const record = state as { connections?: unknown };
  if (!record.connections || typeof record.connections !== 'object') return state;
  // An array is not a valid id → connection map; drop it rather than mint
  // index-keyed connections.
  if (Array.isArray(record.connections)) return { ...record, connections: {} };
  const connections = Object.fromEntries(
    Object.entries(record.connections as Record<string, unknown>).map(([id, conn]) => {
      if (!conn || typeof conn !== 'object') return [id, conn];
      const next = {
        ...(conn as Record<string, unknown>),
        templates: sanitizeTemplates((conn as { templates?: unknown }).templates, schema),
      };
      return [id, extra ? extra(next) : next];
    })
  );
  return { ...record, connections };
}

export function newTemplateId(): string {
  return uuidv4();
}

/** "Message 1", "Message 2", … — the first name not already taken. */
export function nextTemplateName(list: readonly MessageTemplateBase[], prefix: string): string {
  const taken = new Set(list.map((t) => t.name));
  let n = list.length + 1;
  while (taken.has(`${prefix} ${n}`)) n++;
  return `${prefix} ${n}`;
}

export function renameTemplate<T extends MessageTemplateBase>(
  list: readonly T[],
  id: string,
  name: string
): T[] {
  const trimmed = name.trim();
  if (!trimmed) return [...list];
  return list.map((t) => (t.id === id ? { ...t, name: trimmed } : t));
}

export function removeTemplate<T extends MessageTemplateBase>(list: readonly T[], id: string): T[] {
  return list.filter((t) => t.id !== id);
}

/** Move a template one slot up (-1) or down (+1); out-of-range moves are no-ops. */
export function moveTemplate<T extends MessageTemplateBase>(
  list: readonly T[],
  id: string,
  delta: -1 | 1
): T[] {
  const from = list.findIndex((t) => t.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}
