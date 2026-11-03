import type * as KafkaLib from '@platformatic/kafka';

type StartConsumer = Pick<
  KafkaLib.Consumer<Buffer, Buffer, Buffer, Buffer>,
  'listOffsetsWithTimestamps' | 'listOffsets'
>;

/**
 * Group-mode timestamp start: the first offset at/after `timestamp` for every
 * partition of `topics`. A partition with no record that recent (ListOffsets
 * answers -1) starts at its end offset. It must be listed explicitly: MANUAL
 * mode fills an omitted partition from the fallback, which with `earliest`
 * replays the whole partition. Returns an empty list when no partition has a
 * record at/after the timestamp.
 */
export async function timestampStartOffsets(
  consumer: StartConsumer,
  kafka: typeof KafkaLib,
  topics: string[],
  timestamp: bigint
): Promise<KafkaLib.TopicWithPartitionAndOffset[]> {
  const resolved = await consumer.listOffsetsWithTimestamps({ topics, timestamp });
  const offsets: KafkaLib.TopicWithPartitionAndOffset[] = [];
  const empty = new Map<string, number[]>();
  for (const [topic, partitions] of resolved) {
    for (const [partition, { offset }] of partitions) {
      if (offset >= 0n) offsets.push({ topic, partition, offset });
      else empty.set(topic, [...(empty.get(topic) ?? []), partition]);
    }
  }
  if (offsets.length === 0 || empty.size === 0) return offsets;
  const latest = await consumer.listOffsets({
    topics: [...empty.keys()],
    partitions: Object.fromEntries(empty),
    timestamp: kafka.ListOffsetTimestamps.LATEST,
  });
  for (const [topic, partitions] of empty) {
    for (const partition of partitions) {
      const offset = latest.get(topic)?.[partition];
      if (offset === undefined || offset < 0n) {
        throw new Error(`Could not resolve the end offset of ${topic}:${partition}.`);
      }
      offsets.push({ topic, partition, offset });
    }
  }
  return offsets;
}
