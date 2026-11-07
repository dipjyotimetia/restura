import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRequestStore } from '@/store/useRequestStore';

vi.mock('@/lib/shared/telemetry', () => ({ reportError: vi.fn() }));

vi.mock('@/features/sse/components/SseClient', () => ({
  default: () => {
    throw new Error('sse render failure');
  },
}));
vi.mock('@/features/mcp/components/McpRequestBuilder', () => ({
  default: () => {
    throw new Error('mcp render failure');
  },
}));
vi.mock('@/features/mcp/components/McpResultPanel', () => ({
  default: () => <div>mcp result</div>,
}));

import { RequestWorkspace } from '../RequestWorkspace';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useRequestStore.setState((s) => ({ ...s, tabs: [], activeTabId: null }));
});

describe('RequestWorkspace error boundaries', () => {
  it.each(['sse', 'mcp'] as const)(
    'contains a %s render failure and lets the user close the tab',
    async (mode) => {
      const user = userEvent.setup();
      const keep = useRequestStore.getState().createNewRequest('http');
      const broken = useRequestStore.getState().createNewRequest(mode);
      render(
        <RequestWorkspace
          mode={mode}
          orientation="horizontal"
          split={50}
          onSplitChange={() => {}}
        />
      );

      await user.click(await screen.findByRole('button', { name: /close this tab/i }));
      const ids = useRequestStore.getState().tabs.map((t) => t.id);
      expect(ids).not.toContain(broken);
      expect(ids).toContain(keep);
    }
  );
});
