import { expect, test } from '../fixtures/echoLocal';

/**
 * The renderer configures telemetry through the real secret/IPC boundary, then
 * the real Electron OTLP exporter delivers to Echo Local. The recorded request
 * makes this fail if the renderer stops using the desktop bridge, the IPC
 * validator rejects the envelope, or the exporter leaks run content.
 */
test.describe('Desktop agent telemetry', () => {
  test('configures OTLP and exports an allowlisted trace to Echo Local', async ({
    app: page,
    echo,
  }) => {
    await page.evaluate(() => {
      window.location.hash = '#/ai-lab';
    });
    try {
      await page.getByRole('button', { name: 'Agents', exact: true }).click();
      await page.getByText('Agent telemetry', { exact: true }).click();
      await page.getByLabel('Target').selectOption('otlp');
      await page.getByLabel('OTLP traces endpoint').fill(`${echo.httpUrl}/echo`);
      await page.getByRole('button', { name: 'Enable telemetry' }).click();
      await expect(
        page.getByText('Enabled. Only metadata from future agent runs will be exported.')
      ).toBeVisible();

      echo.http.reset();
      const result = await page.evaluate(
        async (endpoint) =>
          window.electron!.aiLab.exportTelemetry({
            config: {
              enabled: true,
              target: 'otlp',
              endpoint,
              environment: 'e2e',
              sampleRate: 1,
              auth: { mode: 'none' },
            },
            trace: {
              id: 'trace-e2e',
              suiteId: 'suite-e2e',
              taskId: 'task-e2e',
              trial: 1,
              agentId: 'agent-e2e',
              startedAt: 1,
              finishedAt: 2,
              events: [
                {
                  id: 'model-e2e',
                  type: 'model.completed',
                  timestamp: 2,
                  providerId: 'local-provider',
                  model: 'local-model',
                  durationMs: 1,
                },
              ],
            },
          }),
        `${echo.httpUrl}/echo`
      );

      expect(result).toMatchObject({ ok: true, delivery: { status: 'sent' } });
      await expect
        .poll(() => echo.http.requests().filter((request) => request.path === '/echo'))
        .toHaveLength(1);
      const request = echo.http.requests().find((entry) => entry.path === '/echo');
      expect(request).toMatchObject({ method: 'POST' });
      expect(request?.body).toContain('agent-e2e');
      expect(request?.body).toContain('local-model');
      expect(request?.body).not.toMatch(/prompt|response|header|body|secret/i);
    } finally {
      await page.evaluate(() => {
        window.location.hash = '#/';
      });
      await expect(page.getByRole('main', { name: 'Request workspace' })).toBeVisible({
        timeout: 15_000,
      });
    }
  });
});
