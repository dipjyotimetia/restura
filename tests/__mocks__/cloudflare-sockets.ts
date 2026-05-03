// Stub for cloudflare:sockets — used only in Vitest (not in production Workers runtime)
import { vi } from 'vitest';

export const connect = vi.fn(() => ({
  readable: new ReadableStream(),
  writable: new WritableStream(),
  startTls: vi.fn(() => ({
    readable: new ReadableStream(),
    writable: new WritableStream(),
    startTls: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  close: vi.fn().mockResolvedValue(undefined),
}));
