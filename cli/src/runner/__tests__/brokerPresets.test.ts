import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadCollection } from '../collectionLoader';

/**
 * Kafka / MQTT connection presets (#984) ride in root `x-restura-kafka` /
 * `x-restura-mqtt` sidecars. The CLI has no broker transport, so `restura run`
 * must load such a collection, skip the presets with a notice, and still run
 * every ordinary request.
 */
const BUNDLED = `opencollection: "1.0.0"
info:
  name: Mixed
bundled: true
items:
  - info:
      type: http
      name: Health
    http:
      method: GET
      url: https://api.example.com/health
  - info:
      name: Events
    items: []
extensions:
  x-restura-kafka:
    - info: { type: kafka, name: Orders }
      folderPath: [Events]
      kafka:
        connection: { bootstrapBrokers: ["localhost:9092"] }
  x-restura-mqtt:
    - info: { type: mqtt, name: Sensors }
      mqtt:
        connection: { brokerUrl: "mqtt://localhost:1883" }
`;

describe('loadCollection with Kafka / MQTT presets', () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'restura-broker-'));
    file = join(dir, 'mixed.yaml');
    await writeFile(file, BUNDLED, 'utf8');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('skips presets with a notice and keeps runnable requests', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await loadCollection(file);
      expect(result.requests.map((r) => r.request.name)).toEqual(['Health']);
      const notices = stderr.mock.calls.map((call) => String(call[0]));
      expect(notices).toEqual(
        expect.arrayContaining([
          expect.stringContaining('skipping Kafka preset "Events/Orders"'),
          expect.stringContaining('skipping MQTT preset "Sensors"'),
        ])
      );
    } finally {
      stderr.mockRestore();
    }
  });
});
