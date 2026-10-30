import { protocolSecretValueSchema } from '@shared/protocol/secret-value-schema';
import { z } from 'zod';

// Kafka connect secrets + TLS (split from kafka.ts for the file-size ratchet).

// Secret-bearing fields added for #918 accept plain string | inline | handle.
// The renderer sends `kafka`-scoped handles, so plaintext is resolved in main
// only (ADR-0007).
// External secret-manager references are refused for Kafka (no opt-in path).
export const KafkaSecretValueSchema = protocolSecretValueSchema
  .refine(
    (value) =>
      typeof value === 'string'
        ? value.length > 0
        : value.kind !== 'inline' || value.value.length > 0,
    'Secret is required'
  )
  .refine(
    (value) => typeof value === 'string' || value.kind !== 'external',
    'External secret references are not supported for Kafka SASL credentials'
  );

/**
 * A stored connection credential (SASL password / static OAuth token, TLS
 * passphrase, registry Basic password): plaintext for legacy callers, or the
 * connection's broker-secret handle (SEC-K3) resolved only in main. `max`
 * keeps the historical cap on the plaintext form.
 */
export const kafkaStoredSecretSchema = (max: number) =>
  KafkaSecretValueSchema.refine(
    (value) =>
      typeof value === 'string'
        ? value.length <= max
        : value.kind !== 'inline' || value.value.length <= max,
    `Secret must be at most ${max} characters`
  );

// Optional variant: an absent / empty plaintext value means "not set" (legacy
// registry Basic auth sends `password: ''`).
export const KafkaOptionalStoredSecretSchema = z.union([
  z.literal(''),
  kafkaStoredSecretSchema(1024),
]);

const KafkaTlsPathSchema = z.string().min(1).max(4096);

export const KafkaTlsSchema = z.object({
  ca: z
    .string()
    .max(64 * 1024)
    .optional(),
  cert: z
    .string()
    .max(64 * 1024)
    .optional(),
  key: z
    .string()
    .max(64 * 1024)
    .optional(),
  // File paths are read in main (loadBrokerTlsFiles, isPathSafe) so PEM
  // material never transits the renderer (SEC-K3). Inline PEM above is kept
  // for programmatic callers.
  caPath: KafkaTlsPathSchema.optional(),
  certPath: KafkaTlsPathSchema.optional(),
  keyPath: KafkaTlsPathSchema.optional(),
  passphrase: KafkaOptionalStoredSecretSchema.optional(),
  rejectUnauthorized: z.boolean().optional(),
});

export type KafkaTlsConfig = z.infer<typeof KafkaTlsSchema>;
