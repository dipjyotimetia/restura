// @vitest-environment node
//
// Live integration check for the issue-#257 Kafka admin/observability path.
// SKIPPED unless KAFKA_E2E=1 and a broker is reachable at KAFKA_BROKER
// (default localhost:9092 — the echo-local Redpanda PLAINTEXT listener).
//
//   docker compose -f echo-local/docker-compose.yml up -d kafka
//   KAFKA_E2E=1 npx vitest run electron/main/__tests__/kafka-admin.live.test.ts
//
// It exercises the REAL @platformatic/kafka calls the handlers use and pipes
// their output through the actual serde helpers — verifying that the real wire
// shapes match the hand-built fixtures the unit tests assume (partition
// discovery, EARLIEST/LATEST sentinels, the lag join, nested-Map flattening).
//
// @platformatic/kafka is imported lazily (dynamic import in beforeAll) so the
// default, skipped run pays nothing for evaluating the heavy library.

import type * as KafkaLib from '@platformatic/kafka';
import type { Admin } from '@platformatic/kafka';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeGroupLag,
  flattenConfigDescriptions,
  flattenGroup,
  topicWatermarks,
} from '../handlers/kafka-serde';

const RUN = process.env.KAFKA_E2E === '1';
const BROKER = process.env.KAFKA_BROKER ?? 'localhost:9092';
const TOPIC = 'restura-257-verify';
const GROUP = 'restura-257-verify-group';
const d = RUN ? describe : describe.skip;

d('Kafka admin/observability — live against a broker', () => {
  let kafka: typeof KafkaLib;
  let admin: Admin;

  beforeAll(async () => {
    kafka = await import('@platformatic/kafka');
    admin = new kafka.Admin({ clientId: 'restura-257-verify', bootstrapBrokers: [BROKER] });
    try {
      await admin.deleteTopics({ topics: [TOPIC] });
    } catch {
      /* fresh broker — topic may not exist */
    }
    await admin.createTopics({ topics: [TOPIC], partitions: 3, replicas: 1 });

    const producer = new kafka.Producer({
      clientId: 'restura-257-verify',
      bootstrapBrokers: [BROKER],
      serializers: {
        key: (v?: string) => (v == null ? undefined : Buffer.from(v)),
        value: (v?: string) => (v == null ? undefined : Buffer.from(v)),
      },
    });
    await producer.send({
      messages: Array.from({ length: 9 }, (_, i) => ({
        topic: TOPIC,
        partition: i % 3,
        value: `m${i}`,
      })),
    });
    await producer.close();

    // Establish the consumer group (so describeGroups returns it), then close so
    // it goes inactive.
    const consumer = new kafka.Consumer({
      clientId: 'restura-257-verify',
      bootstrapBrokers: [BROKER],
      groupId: GROUP,
      autocommit: false,
      deserializers: { key: (b: Buffer | undefined) => b, value: (b: Buffer | undefined) => b },
    });
    const stream = await consumer.consume({
      topics: [TOPIC],
      mode: kafka.MessagesStreamModes.EARLIEST,
    });
    let seen = 0;
    for await (const _msg of stream) {
      if (++seen >= 3) break;
    }
    await stream.close();
    await consumer.close(true);

    // Set deterministic committed offsets (2 of 3 per partition → total lag 3).
    // This is exactly the resetGroupOffsets handler's core call, so it also
    // verifies that path against the real broker. The group must be inactive,
    // which it now is — retry briefly in case the coordinator is still settling.
    for (let attempt = 0; ; attempt++) {
      try {
        await admin.alterConsumerGroupOffsets({
          groupId: GROUP,
          topics: [
            { name: TOPIC, partitionOffsets: [0, 1, 2].map((p) => ({ partition: p, offset: 2n })) },
          ],
        });
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    try {
      await admin.deleteGroups({ groups: [GROUP] });
    } catch {
      /* group may be non-empty/active — ignore in teardown */
    }
    try {
      await admin.deleteTopics({ topics: [TOPIC] });
    } catch {
      /* ignore */
    }
    await admin.close();
  });

  it('discovers partitions via metadata (partitionsCount populated)', async () => {
    const meta = await admin.metadata({
      topics: [TOPIC],
      autocreateTopics: false,
      forceUpdate: true,
    });
    expect(meta.topics.get(TOPIC)?.partitionsCount).toBe(3);
  });

  it('topicWatermarks pairs real EARLIEST/LATEST listOffsets (3 produced per partition)', async () => {
    const T = kafka.ListOffsetTimestamps;
    const indexes = [0, 1, 2];
    const [earliest, latest] = await Promise.all([
      admin.listOffsets({
        topics: [
          {
            name: TOPIC,
            partitions: indexes.map((p) => ({ partitionIndex: p, timestamp: T.EARLIEST })),
          },
        ],
      }),
      admin.listOffsets({
        topics: [
          {
            name: TOPIC,
            partitions: indexes.map((p) => ({ partitionIndex: p, timestamp: T.LATEST })),
          },
        ],
      }),
    ]);
    const watermarks = topicWatermarks(earliest[0]?.partitions ?? [], latest[0]?.partitions ?? []);
    expect(watermarks).toHaveLength(3);
    expect(watermarks.every((w) => w.count === '3')).toBe(true);
  });

  it('flattenConfigDescriptions over real describeConfigs returns a non-empty config table', async () => {
    const configs = await admin.describeConfigs({
      resources: [{ resourceType: kafka.ConfigResourceTypes.TOPIC, resourceName: TOPIC }],
    });
    const flat = flattenConfigDescriptions(configs);
    expect(flat.length).toBeGreaterThan(0);
    expect(flat.some((c) => c.name === 'cleanup.policy')).toBe(true);
  });

  it('flattenGroup over real describeGroups returns the committed group', async () => {
    const map = await admin.describeGroups({ groups: [GROUP] });
    const raw = map.get(GROUP);
    expect(raw).toBeTruthy();
    const flat = flattenGroup(raw!);
    expect(flat.id).toBe(GROUP);
    expect(typeof flat.state).toBe('string');
  });

  it('computeGroupLag joins real committed offsets with LATEST watermarks', async () => {
    const committedGroups = await admin.listConsumerGroupOffsets({ groups: [{ groupId: GROUP }] });
    const committed = committedGroups.find((g) => g.groupId === GROUP)?.topics ?? [];
    expect(committed.length).toBeGreaterThan(0);

    const T = kafka.ListOffsetTimestamps;
    const latestReq = committed
      .filter((t) => t.partitions.length > 0)
      .map((t) => ({
        name: t.name,
        partitions: t.partitions.map((p) => ({
          partitionIndex: p.partitionIndex,
          timestamp: T.LATEST,
        })),
      }));
    const latest = await admin.listOffsets({ topics: latestReq });
    const lag = computeGroupLag(committed, latest);

    // 9 produced (3/partition), 6 committed → total lag 3 across the topic.
    expect(lag.length).toBeGreaterThan(0);
    const totalLag = lag.reduce((s, r) => s + Number(r.lag), 0);
    expect(totalLag).toBe(3);
  });

  it('consumer.listOffsetsWithTimestamps resolves offsets for the timestamp seek path', async () => {
    const consumer = new kafka.Consumer({
      clientId: 'restura-257-verify',
      bootstrapBrokers: [BROKER],
      groupId: `${GROUP}-ts`,
      deserializers: { key: (b: Buffer | undefined) => b, value: (b: Buffer | undefined) => b },
    });
    try {
      const resolved = await consumer.listOffsetsWithTimestamps({ topics: [TOPIC], timestamp: 1n });
      const partitionMap = resolved.get(TOPIC);
      expect(partitionMap).toBeTruthy();
      // Every partition got 3 messages from t≈now, so timestamp=1 (epoch ms)
      // resolves to offset 0 on each.
      const offsets = [...(partitionMap?.values() ?? [])].map((v) => v.offset);
      expect(offsets.every((o) => o >= 0n)).toBe(true);
    } finally {
      await consumer.close(true);
    }
  });
});
