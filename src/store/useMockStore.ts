import { create } from 'zustand';
import type { MockServerStatus } from '@/types';

/**
 * Tracks the desktop mock server's running state in the renderer. The server
 * itself lives in the Electron main process (`mock-server-handler.ts`); this
 * store mirrors its status so the UI can show "running on :PORT" and offer
 * start/stop. Not persisted — the server doesn't survive an app restart.
 */
interface MockState {
  status: MockServerStatus;
  setStatus: (status: MockServerStatus) => void;
}

export const useMockStore = create<MockState>((set) => ({
  status: { running: false },
  setStatus: (status) => set({ status }),
}));
