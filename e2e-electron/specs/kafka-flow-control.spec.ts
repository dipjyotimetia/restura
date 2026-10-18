import { Admin, Producer, stringSerializers } from '@platformatic/kafka';
import { dockerAvailable, expect, test } from '../fixtures/brokers';

// Requires the Dockerised Redpanda broker; skip (don't fail) when Docker is absent.
const describeOrSkip = dockerAvailable() ? test.describe : test.describe.skip;

const BROKERS = ['localhost:9092'];

/**
 * Live-consumer flow control against a REAL broker (#938, #942): per-partition
 * pause, seek on a paused and on a running partition, and — the data-safety
 * property — automatic commits never advance a paused partition past what was
 * actually delivered. Topic setup, producing, and the committed-offset check
 * run in the test process with the same client library; everything the user
 * does goes through the desktop UI → IPC → kafka-handler.
 */
describeOrSkip('Desktop Kafka flow control (live Redpanda broker)', () => {
  test('pause / seek / resume partitions and commit only delivered records', async ({
    app: page,
    brokers,
  }) => {
    test.setTimeout(120_000);
    expect(brokers.kafka).toBe(BROKERS[0]);
    const stamp = String(Date.now());
    const topic = `restura-flow-${stamp}`;
    const admin = new Admin({ clientId: `restura-e2e-admin-${stamp}`, bootstrapBrokers: BROKERS });
    const producer = new Producer({
      clientId: `restura-e2e-producer-${stamp}`,
      bootstrapBrokers: BROKERS,
      serializers: stringSerializers,
    });
    try {
      await admin.createTopics({ topics: [topic], partitions: 3, replicas: 1 });

      await page.getByRole('button', { name: 'new request', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Kafka client' }).click();
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(page.getByRole('button', { name: /Disconnect/ })).toBeVisible({
        timeout: 20_000,
      });

      await page.getByRole('tab', { name: 'Consume' }).click();
      const consume = page.getByRole('tabpanel', { name: 'Consume' });
      const groupId = await consume
        .locator('xpath=.//label[normalize-space()="Consumer group ID"]/following-sibling::input')
        .inputValue();
      expect(groupId).not.toBe('');
      await consume.getByPlaceholder('topic-name').fill(topic);
      await consume.getByRole('button', { name: 'Add', exact: true }).click();
      await consume.getByLabel('Consume start position').selectOption('earliest');
      await consume.getByRole('button', { name: 'Subscribe', exact: true }).click();
      await expect(consume.getByText('Subscription: Subscribed')).toBeVisible({ timeout: 20_000 });

      // Assigned partitions appear once the lag monitor reports (every second).
      const partitions = consume.getByRole('region', { name: 'Partitions' });
      const pauseButton = (p: number) =>
        partitions.getByRole('button', { name: `Pause ${topic} partition ${p}` });
      const resumeButton = (p: number) =>
        partitions.getByRole('button', { name: `Resume ${topic} partition ${p}` });
      await expect(pauseButton(2)).toBeVisible({ timeout: 20_000 });
      await pauseButton(1).click();
      await expect(resumeButton(1)).toBeVisible();
      await pauseButton(2).click();
      await expect(resumeButton(2)).toBeVisible();

      await producer.send({
        messages: [0, 1, 2].flatMap((partition) =>
          [0, 1, 2].map((i) => ({ topic, partition, value: `p${partition}-${i}-${stamp}` }))
        ),
      });

      const record = (partition: number, offset: number) =>
        page.getByRole('button', {
          name: `Kafka record in ${topic}, partition ${partition}, offset ${offset}`,
          exact: true,
        });
      await page.getByRole('tab', { name: /Messages/ }).click();
      await expect(record(0, 2)).toBeVisible({ timeout: 20_000 });
      await expect(record(0, 0)).toHaveCount(1);
      // Paused partitions deliver nothing.
      await expect(record(1, 0)).toHaveCount(0);
      await expect(record(2, 0)).toHaveCount(0);

      // Seek a paused partition, then resume: it lands exactly where it was seeked.
      await page.getByRole('tab', { name: 'Consume' }).click();
      await partitions.getByLabel('Seek partition').selectOption(`${topic}:1`);
      await partitions.getByLabel('Offset').fill('1');
      await partitions.getByRole('button', { name: 'Seek', exact: true }).click();
      await expect(partitions.getByRole('status')).toHaveText(
        `${topic} partition 1 will resume from offset 1`
      );
      await resumeButton(1).click();
      await expect(pauseButton(1)).toBeVisible();

      // Seek a running partition backwards: its records are delivered again.
      await partitions.getByLabel('Seek partition').selectOption(`${topic}:0`);
      await partitions.getByLabel('Offset').fill('0');
      await partitions.getByRole('button', { name: 'Seek', exact: true }).click();
      await expect(partitions.getByRole('status')).toHaveText(
        `${topic} partition 0 now reads from offset 0`
      );

      await page.getByRole('tab', { name: /Messages/ }).click();
      await expect(record(1, 2)).toBeVisible({ timeout: 20_000 });
      await expect(record(1, 1)).toHaveCount(1);
      await expect(record(1, 0)).toHaveCount(0);
      await expect(record(0, 0)).toHaveCount(2, { timeout: 20_000 });
      await expect(record(2, 0)).toHaveCount(0);

      // Unsubscribe with partition 2 still paused (flushes delivered positions).
      await page.getByRole('tab', { name: 'Consume' }).click();
      await consume.getByRole('button', { name: 'Unsubscribe', exact: true }).click();
      await expect(consume.getByText('Subscription: Idle')).toBeVisible({ timeout: 20_000 });

      const [group] = await admin.listConsumerGroupOffsets({ groups: [{ groupId }] });
      const committed = new Map(
        (group?.topics.find((t) => t.name === topic)?.partitions ?? []).map((p) => [
          p.partitionIndex,
          p.committedOffset,
        ])
      );
      expect(committed.get(0)).toBe(3n);
      expect(committed.get(1)).toBe(3n);
      // Never delivered → never committed (absent or the broker's -1 sentinel).
      expect(committed.get(2) ?? -1n).toBeLessThan(0n);

      await page
        .getByRole('button', { name: /Disconnect/ })
        .first()
        .click()
        .catch(() => {});
    } finally {
      await producer.close().catch(() => {});
      await admin.deleteTopics({ topics: [topic] }).catch(() => {});
      await admin.close().catch(() => {});
    }
  });
});
