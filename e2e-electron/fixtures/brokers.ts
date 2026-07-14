import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test as electronTest } from './electronApp';

/**
 * Ensures the Dockerised Kafka (Redpanda) + MQTT (EMQX) brokers from
 * `echo-local/docker-compose.yml` are up and healthy, then exposes their
 * addresses. Idempotent — a fast no-op when the stack is already running, so
 * local re-runs don't pay the bring-up cost. Brokers are LEFT running on
 * teardown (stop with `docker compose -f echo-local/docker-compose.yml down -v`).
 *
 * These are the only desktop protocols that need a real broker (no in-process
 * mock exists — see echo-local/docker-compose.yml). Kept as their own fixture so
 * the broker-less specs never pay the Docker cost or require Docker at all.
 */
const ROOT = path.resolve(__dirname, '../..');
const COMPOSE = path.join(ROOT, 'echo-local/docker-compose.yml');

export interface Brokers {
  /** Kafka PLAINTEXT bootstrap broker (Redpanda) — the client's default. */
  kafka: string;
  /** MQTT broker URL (EMQX) — the client's default. */
  mqtt: string;
}

/** Whether the Docker CLI/daemon is reachable — gate the broker specs on it so
 *  a dev without Docker gets a skip, not a hard failure. */
export function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version'], { stdio: 'pipe', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export const test = electronTest.extend<NonNullable<unknown>, { brokers: Brokers }>({
  brokers: [
    // biome-ignore lint/correctness/noEmptyPattern: legacy type boundary
    async ({}, use) => {
      // `up -d` (idempotent; a no-op when already running) brings up the stack.
      // We poll the broker healthchecks ourselves rather than using `--wait`,
      // which mis-reports the one-shot cert/config/setup containers (exited 0)
      // as failures on a re-up. Images are assumed pre-pulled.
      execFileSync('docker', ['compose', '-f', COMPOSE, 'up', '-d'], {
        cwd: ROOT,
        stdio: 'pipe',
        timeout: 240_000,
      });

      const isHealthy = (container: string): boolean => {
        try {
          const status = execFileSync(
            'docker',
            ['inspect', '-f', '{{.State.Health.Status}}', container],
            { stdio: 'pipe' }
          )
            .toString()
            .trim();
          return status === 'healthy';
        } catch {
          return false;
        }
      };

      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline && !(isHealthy('kafka') && isHealthy('restura-echo-emqx'))) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      if (!(isHealthy('kafka') && isHealthy('restura-echo-emqx'))) {
        throw new Error('Kafka/MQTT brokers did not become healthy within 180s');
      }

      await use({ kafka: 'localhost:9092', mqtt: 'mqtt://localhost:1883' });
    },
    { scope: 'worker' },
  ],
});

export { expect } from './electronApp';
