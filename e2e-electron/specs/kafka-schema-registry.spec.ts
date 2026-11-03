import { Admin } from '@platformatic/kafka';
import { dockerAvailable, expect, test } from '../fixtures/brokers';

// Requires the Dockerised Redpanda broker + its bundled Schema Registry (:8081).
const describeOrSkip = dockerAvailable() ? test.describe : test.describe.skip;
const REGISTRY = 'http://localhost:8081';

/**
 * Desktop Schema Registry round trip through the real UI: connect with a
 * registry, produce a value encoded by schema ID (Avro with a 64-bit id beyond
 * 2^53, typed as a plain JSON number), consume it, and check the inspector
 * shows the decoded record with every digit and its schema label. The codec
 * matrix itself is covered by kafka-schema-matrix.live.test.ts.
 */
describeOrSkip('Desktop Kafka Schema Registry (live Redpanda)', () => {
  test('produces by schema ID and inspects the decoded record without rounding', async ({
    app: page,
    brokers,
  }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    expect(brokers.kafka).toBe('localhost:9092');
    const stamp = await page.evaluate(() => String(Date.now()));
    const topic = `restura-e2e-sr-${stamp}`;

    const admin = new Admin({ clientId: 'restura-e2e-sr', bootstrapBrokers: [brokers.kafka] });
    await admin.createTopics({ topics: [topic], partitions: 1, replicas: 1 });
    await admin.close();
    const registered = await fetch(`${REGISTRY}/subjects/${topic}-value/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.schemaregistry.v1+json' },
      body: JSON.stringify({
        schema: JSON.stringify({
          type: 'record',
          name: 'Order',
          namespace: 'e2e.sr',
          fields: [
            { name: 'id', type: 'long' },
            { name: 'sku', type: 'string' },
          ],
        }),
      }),
    });
    const { id: schemaId } = (await registered.json()) as { id: number };
    expect(schemaId).toBeGreaterThan(0);
    const jsonRegistered = await fetch(`${REGISTRY}/subjects/${topic}-json/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.schemaregistry.v1+json' },
      body: JSON.stringify({
        schemaType: 'JSON',
        schema: JSON.stringify({ type: 'object', properties: { big: { type: 'integer' } } }),
      }),
    });
    const { id: jsonSchemaId } = (await jsonRegistered.json()) as { id: number };

    await page.getByRole('button', { name: 'new request', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Kafka client' }).click();

    // Enable the registry on the connection, then connect.
    await page.getByRole('tab', { name: 'Connection' }).click();
    await page
      .getByText('Schema Registry', { exact: true })
      .locator('xpath=..')
      .getByRole('switch')
      .click();
    await page.getByPlaceholder('https://schema-registry:8081').fill(REGISTRY);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(
      page.getByRole('status', { name: 'Kafka connection status: Connected' })
    ).toBeVisible({ timeout: 20_000 });

    await page.getByRole('tab', { name: 'Consume' }).click();
    const consume = page.getByRole('tabpanel', { name: 'Consume' });
    await consume.getByPlaceholder('topic-name').fill(topic);
    await consume.getByRole('button', { name: 'Add', exact: true }).click();
    await consume.getByLabel('Consume start position').selectOption('earliest');
    await consume.getByRole('button', { name: 'Subscribe', exact: true }).click();
    await expect(consume.getByText(/Subscription: (Subscribed|Browsing)/)).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole('tab', { name: 'Produce' }).click();
    const produce = page.getByRole('tabpanel', { name: 'Produce' });
    await produce.getByRole('tab', { name: 'Single record' }).click();
    await produce.getByPlaceholder('my-topic').fill(topic);
    await produce.getByRole('combobox', { name: 'Value schema source' }).click();
    await page.getByRole('option', { name: 'Schema ID', exact: true }).click();
    await produce.getByRole('spinbutton', { name: 'Value schema ID' }).fill(String(schemaId));
    await produce
      .getByLabel('Kafka message value')
      .fill('{"id": 1793000000000000001, "sku": "A-1"}');
    await produce.getByRole('button', { name: 'Publish' }).click();

    await page.getByRole('tab', { name: /Messages/ }).click();
    const decoded = '"id":"1793000000000000001"';
    await expect(page.getByText(decoded).first()).toBeVisible({ timeout: 20_000 });
    await page.getByText(decoded).last().click();
    // Id only: the registry dedupes identical schemas, so the subject in the
    // label can be another subject (e.g. a previous run's) sharing this id.
    await expect(page.getByText(new RegExp(`Schema ${schemaId} \\(.+ v\\d+\\)`))).toBeVisible();
    await expect(
      page.locator('pre').filter({ hasText: '"id": "1793000000000000001"' })
    ).toBeVisible();

    // JSON Schema keeps a large integer as a JSON number: the inspector must
    // pretty-print it without rounding (JSON.parse/stringify would print …992).
    await page.getByRole('tab', { name: 'Produce' }).click();
    await produce.getByRole('spinbutton', { name: 'Value schema ID' }).fill(String(jsonSchemaId));
    await produce.getByLabel('Kafka message value').fill('{"big": 9007199254740993}');
    await produce.getByRole('button', { name: 'Publish' }).click();
    await page.getByRole('tab', { name: /Messages/ }).click();
    await expect(page.getByText('{"big":9007199254740993}').first()).toBeVisible({
      timeout: 20_000,
    });
    await page.getByText('{"big":9007199254740993}').last().click();
    await expect(page.locator('pre').filter({ hasText: '"big": 9007199254740993' })).toBeVisible();

    await page
      .getByRole('button', { name: /Disconnect/ })
      .first()
      .click()
      .catch(() => {});
    expect(consoleErrors).toEqual([]);
  });
});
