import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadCollection } from '../collectionLoader';

/**
 * WebSocket / Socket.IO connections (#1209): a native OC `websocket` item and a
 * root `x-restura-socketio` entry. They are not runnable requests — the CLI
 * must skip them with a notice (as the app's runner does) and still run every
 * ordinary request.
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
      name: Live
    items:
      - info:
          type: websocket
          name: Feed
        websocket:
          url: wss://echo.example.com
extensions:
  x-restura-socketio:
    - info: { type: socketio, name: Chat }
      socketio:
        url: https://chat.example.com
`;

describe('loadCollection with WebSocket / Socket.IO items', () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'restura-stream-'));
    file = join(dir, 'mixed.yaml');
    await writeFile(file, BUNDLED, 'utf8');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('skips them with a named notice and keeps runnable requests', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await loadCollection(file);
      expect(result.requests.map((r) => r.request.name)).toEqual(['Health']);
      const notices = stderr.mock.calls.map((call) => String(call[0]));
      expect(notices).toEqual(
        expect.arrayContaining([
          expect.stringContaining('skipping WebSocket preset "Live/Feed"'),
          expect.stringContaining('skipping Socket.IO preset "Chat"'),
        ])
      );
    } finally {
      stderr.mockRestore();
    }
  });
});
