# Kafka client

Kafka is a desktop-only client because browser targets cannot open Kafka TCP connections. A Kafka connection owns a producer and may also own one consumer, producer stream, or producer transaction session.

## Produce

- Records use explicit UTF-8, Base64, Schema Registry, or null field variants. An empty UTF-8/Base64 payload is different from a null tombstone.
- Keys and values can use independent encodings and Schema Registry IDs.
- Headers preserve their raw bytes; the message inspector exposes Base64 alongside the UTF-8 convenience view.
- A record may set a partition and precision-safe epoch-millisecond timestamp.
- Interactive batches accept up to 1,000 typed records.
- Producer streams expose bounded batching/backpressure controls.
- Transaction sessions require idempotence and a stable transactional ID. Streams and transactions are mutually exclusive. Disconnect aborts an unfinished transaction.

## Consume

New connections start from committed group offsets and fall back to latest when no commit exists. Persisted v1 connections retain their previous earliest/latest choice during the v2 migration.

Consumers support committed, latest, earliest, explicit offset, and timestamp starts; automatic or per-message manual commits; read-committed isolation; classic or consumer group protocols; static membership; fetch/heartbeat/rebalance tuning; real stream pause/resume; group lifecycle events; and periodic lag.

“Freeze view” only freezes the renderer list. “Pause consumer” invokes the Kafka stream pause primitive.

## Authentication

Supported SASL mechanisms are PLAIN, SCRAM-SHA-256, SCRAM-SHA-512, and static-token OAUTHBEARER. Passwords, TLS passphrases, registry passwords, and OAuth tokens are stored through desktop secure storage and replaced by sentinels in persisted renderer state.

GSSAPI and custom authentication callbacks are intentionally not exposed because they require executable callback/provider code rather than bounded declarative configuration.

## Administration

The Admin tab covers topics, consumer groups, cluster metadata, ACLs, and client quotas. Partition/config/quota changes default to validate-only where Kafka supports it. Destructive or applied changes require operation-specific typed confirmation.

The UI does not expose dependency extension points that execute arbitrary code, including custom partitioners, credential callbacks, or injected metrics collectors.

## Security limitation

Bootstrap brokers pass the Kafka broker guard before connection. `@platformatic/kafka` 2.8 does not expose a supported DNS lookup/connection injection point, and metadata may discover additional brokers, so DNS pinning and post-discovery broker validation are not currently possible. See [ADR 0006](adr/0006-electron-connection-and-dns-hardening.md).

## Local verification

`echo-local/docker-compose.yml` pins Redpanda and creates `echo` plus `echo-compacted` fixtures. The Electron Kafka E2E suite uses the same broker and skips explicitly when Docker is unavailable.
