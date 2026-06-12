import { test, expect } from '../fixtures/electronApp';

/**
 * Desktop launch smoke: the packaged-layout (unpacked) app boots, loads the
 * renderer from dist/web via file://, and the preload bridge is live.
 */
test.describe('Desktop app launch', () => {
  test('renders the request workspace', async ({ app: page }) => {
    await expect(page.getByRole('main', { name: 'Request workspace' })).toBeVisible();
  });

  test('exposes the preload IPC bridge with every protocol surface', async ({ app: page }) => {
    const surfaces = await page.evaluate(() => {
      const api = (window as unknown as { electron?: Record<string, unknown> }).electron;
      if (!api) return null;
      return {
        http: !!api.http,
        grpc: !!api.grpc,
        websocket: !!api.websocket,
        socketio: !!api.socketio,
        sse: !!api.sse,
        mcp: !!api.mcp,
        kafka: !!api.kafka,
        mqtt: !!api.mqtt,
        ai: !!api.ai,
      };
    });
    expect(surfaces).not.toBeNull();
    expect(surfaces).toEqual({
      http: true,
      grpc: true,
      websocket: true,
      socketio: true,
      sse: true,
      mcp: true,
      kafka: true,
      mqtt: true,
      ai: true,
    });
  });
});
