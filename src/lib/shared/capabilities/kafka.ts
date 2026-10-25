// Capability rows: Kafka.
// Order is significant: it is the row order of docs/CAPABILITY_MATRIX.md.
import type { CapabilityRow } from './types';

export const KAFKA_CAPABILITIES = {
  'kafka.basic': {
    label: 'Kafka produce / consume',
    web: false,
    desktop: true,
    notes: 'Native broker protocol; no browser TCP',
  },
  'kafka.schemaRegistry': {
    label: 'Kafka Confluent Schema Registry (subject produce, browse, decode)',
    web: false,
    desktop: true,
    notes:
      'Desktop main-process client: Basic or Bearer (SecretRef) auth, Settings TLS policy (custom CA, mTLS, verify) for HTTPS, broker-aligned SSRF policy (per-socket DNS checks refuse metadata and disabled loopback), no credentials over public plain HTTP; Avro/JSON Schema example generation, Protobuf view-only',
  },
  'kafka.saslOAuthRefresh': {
    label: 'Kafka SASL/OAUTHBEARER client-credentials (auto-refresh)',
    web: false,
    desktop: true,
    notes:
      'Token fetched in main through the SSRF-guarded, DNS-pinned fetch; https is required except for loopback hosts and private IP literals (private addresses still need the "allow private IPs" setting); refreshed once < max(30s, 25% of lifetime) remains; client secret is a kafka-scoped SecretRef handle',
  },
  'kafka.saslMskIam': {
    label: 'Kafka AWS MSK IAM',
    web: false,
    desktop: true,
    notes:
      'SigV4-presigned OAUTHBEARER token; access keys (SecretRef handles) or a named AWS profile; SASL_SSL only; brokers must be MSK hosts in the region unless explicitly opted out',
  },
  'kafka.saslGssapi': {
    label: 'Kafka SASL/GSSAPI (Kerberos)',
    web: false,
    desktop: false,
    notes:
      'Authenticator is implemented, but the native kerberos module is not bundled; the option is disabled in the form',
  },
} as const satisfies Record<string, CapabilityRow>;
