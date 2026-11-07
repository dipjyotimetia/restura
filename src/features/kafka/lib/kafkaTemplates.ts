import { z } from 'zod';
import type { MessageTemplateBase } from '@/lib/shared/streaming/messageTemplates';

/** Composer encodings a saved produce keeps (mirrors the producer panel's modes). */
export type KafkaTemplateEncoding = 'utf8' | 'base64' | 'json';

/**
 * A saved Kafka produce — same UX as MQTT publish templates. Stored
 * unresolved on the connection (`{{var}}` resolves at send time through
 * produceWithVariables) and persisted with the Dexie-backed Kafka store.
 */
export interface KafkaProduceTemplate extends MessageTemplateBase {
  key: string;
  keyEncoding: KafkaTemplateEncoding;
  value: string;
  valueEncoding: KafkaTemplateEncoding;
  tombstone: boolean;
  headers: Array<{ key: string; value: string }>;
  /** Empty = let the partitioner choose. */
  partition: string;
}

const encoding = z.enum(['utf8', 'base64', 'json']);

export const kafkaTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  key: z.string(),
  keyEncoding: encoding,
  value: z.string(),
  valueEncoding: encoding,
  tombstone: z.boolean(),
  headers: z.array(z.object({ key: z.string(), value: z.string() })),
  partition: z.string(),
});
