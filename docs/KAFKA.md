# Kafka client

Kafka is a desktop-only client because browser targets cannot open Kafka TCP connections. A Kafka connection owns a producer and may also own one consumer, producer stream, or producer transaction session.

## Produce

- Records use explicit UTF-8, Base64, Schema Registry, or null field variants. An empty UTF-8/Base64 payload is different from a null tombstone.
- Keys and values can use independent encodings and Schema Registry schemas, named either by numeric schema ID or by `{ subject, version }` where version is a number or `latest`. The main process resolves subjects to IDs (`getLatestSchemaId` / `getRegistryId`) at send time; an unknown subject fails the produce with the registry's error.
- Headers preserve their raw bytes; the message inspector exposes Base64 alongside the UTF-8 convenience view.
- A record may set a partition and precision-safe epoch-millisecond timestamp.
- Interactive batches accept up to 1,000 typed records.
- Producer streams expose bounded batching/backpressure controls.
- Transaction sessions require idempotence and a stable transactional ID. Streams and transactions are mutually exclusive. Disconnect aborts an unfinished transaction.

## Consume

A consumer runs in one of two modes (`membership` on the `kafka:subscribe` IPC payload):

- **Browse** (default for new connections) is read-only. It never joins or creates a consumer group and never commits offsets (#930, #980). `@platformatic/kafka`'s `Consumer.consume()` always joins a group first, so browse mode does not use it. `electron/main/handlers/kafka/browse-consumer.ts` resolves start positions with `listOffsets()` (ListOffsets) and drives a fetch loop over `Consumer.fetch()` (Metadata + Fetch against each partition leader). The loop is exposed as a Readable, so pause/resume, unsubscribe and backpressure work as they do for the native stream. The Consumer is built with a placeholder group ID that is never sent, because no group API (`consume`, `commit`, `joinGroup`, lag monitoring) is called and the classic protocol's `close()` only leaves a group it joined. Starts: latest, earliest, last N per partition (`max(earliest, latest − N)`), explicit offsets (only the listed partitions, clamped to the retained range), and timestamp (offset `-1` waits at latest). An optional `maxMessages` ends the stream; the handler forwards any records still being decoded, then closes the stream and releases the consumer (a fetch error releases it too). Each partition leader runs its own fetch loop, so a quiet leader's long-poll never delays another; an empty fetch backs that leader off for 200 ms, `maxWaitTime` is floored at 100 ms, and a full buffer stops new fetches until the stream is read. `OFFSET_OUT_OF_RANGE` (retention moved the log start) re-runs ListOffsets for the affected partitions and clamps them into the retained range. The partition set is fixed when the stream opens: partitions added later are not picked up until the next subscribe. Browse connects to the leaders the cluster advertises, exactly like group mode, so it inherits the advertised-leader residual risk described in ADR-0006 (the broker guard checks bootstrap addresses only). The IPC schema rejects `groupId`, `committed`, manual commits, the consumer group protocol, static membership and the group-only tuning fields (`fallbackMode`, `autoCommitIntervalMs`, session/rebalance/heartbeat timeouts, `lagIntervalMs`) in browse mode, and caps browse offsets and timestamps at the signed 64-bit maximum.
- **Consumer group** is unchanged. It supports committed, latest, earliest, explicit offset and timestamp starts; automatic or per-message manual commits; classic or consumer group protocols; static membership; fetch/heartbeat/rebalance tuning; group lifecycle events; and periodic lag. A missing commit falls back to latest by default.

Both modes support read-committed isolation and real stream pause/resume.

Persisted v1 connections keep their earliest/latest choice during the v2 migration. The v3 migration adds `membership`. Connections whose group ID was changed from the generated `restura-<id8>` stay in group mode. Default-group connections move to browse, and a `committed` start becomes "last 50 per partition".

“Freeze view” only freezes the renderer list. “Pause consumer” invokes the Kafka stream pause primitive.

## Authentication

Supported SASL mechanisms are PLAIN, SCRAM-SHA-256, SCRAM-SHA-512, and static-token OAUTHBEARER. Passwords, TLS passphrases, registry passwords, inline registry bearer tokens, and OAuth tokens are stored through desktop secure storage and replaced by sentinels in persisted renderer state.

GSSAPI and custom authentication callbacks are intentionally not exposed because they require executable callback/provider code rather than bounded declarative configuration.

## Schema Registry

The registry client lives in `electron/main/handlers/kafka/registry.ts`, one per connection. Every registry request — library encode/decode/resolve and the read-only browse IPC (`kafka:registry-list-subjects`, `kafka:registry-list-versions`, `kafka:registry-get-schema`; validated and rate-limited) — goes through a single Node agent that:

- carries the execution policy's host-selected TLS material for HTTPS registries (`resolveSchemaRegistryExecutionPolicy`: custom CA, mTLS client certificate, verify toggle, TLS version/ciphers); an active proxy fails closed;
- resolves the registry hostname on every new socket and refuses any other hostname. Answers follow the broker posture: cloud-metadata addresses (including IPv4-mapped / embedded IPv6 forms) are always refused and loopback only when `allowLocalhost` is off; private addresses are allowed, as they are for broker hostnames. The URL as written gets the same string-level check as brokers (`assertRegistryUrlSafe`), so literal private IPs follow `allowPrivateIPs`.

Auth is HTTP Basic (unchanged; the untyped legacy IPC shape still means Basic) or Bearer. The bearer token is a `SecretValue`: inline tokens follow the sentinel + secure-storage path, keychain handles and external references cross IPC as references and are resolved only in main (ADR-0007). Handles must carry the `kafka` scope (the token field stores them that way); other handles are refused. Tokens are resolved once at connect, so rotating a stored handle needs a reconnect. Credentials are refused over plain HTTP unless the registry is loopback or every DNS answer is private; for credentialed `http://` hostnames the private-answer rule is re-checked on every new socket.

Avro `bytes` / `fixed` values are accepted as strings (code points 0-255, the Avro JSON convention) and converted to bytes before encoding, so generated examples encode as-is. Schema-label lookups on the consume path wait at most 2 s; 404/405 misses are cached for good, other failures and timeouts for 30 s before the id is retried. Consumed registry-decoded fields carry `{ id, subject?, version? }`, looked up once per schema ID via `/schemas/ids/{id}/versions` and cached.

## Administration

The Admin tab covers topics, consumer groups, cluster metadata, ACLs, and client quotas. Partition/config/quota changes default to validate-only where Kafka supports it. Destructive or applied changes require operation-specific typed confirmation.

The UI does not expose dependency extension points that execute arbitrary code, including custom partitioners, credential callbacks, or injected metrics collectors.

## Security limitation

Bootstrap brokers pass the Kafka broker guard before connection. `@platformatic/kafka` 2.14 does not expose a supported DNS lookup/connection injection point, and metadata may discover additional brokers, so DNS pinning and post-discovery broker validation are not currently possible. See [ADR 0006](adr/0006-electron-connection-and-dns-hardening.md).

Brokers are entered as `host:port`; IPv6 literals use brackets (`[2001:db8::10]:9093`, RFC 3986). The same guard applies to the address, so under a restrictive execution policy IPv6 loopback, ULA, link-local and IPv4-mapped literals are rejected like their IPv4 equivalents.

## Local verification

`echo-local/docker-compose.yml` pins Redpanda and creates `echo` plus `echo-compacted` fixtures. The Electron Kafka E2E suite uses the same broker and skips explicitly when Docker is unavailable.
