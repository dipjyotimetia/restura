import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';
import McpResultPanel from '../McpResultPanel';

vi.mock('@/components/shared/CodeEditor', () => ({
  default: ({ value }: { value: string }) => <pre data-testid="editor">{value}</pre>,
}));

describe('McpResultPanel', () => {
  beforeEach(() => {
    useMcpStore.setState({ connections: {}, activeConnectionId: null });
  });

  it('shows an empty state until a tool has been invoked', () => {
    render(<McpResultPanel />);
    expect(screen.getByText('No result yet')).toBeInTheDocument();
  });

  it('renders the latest result through the JSON body view', async () => {
    const id = useMcpStore.getState().createConnection('https://mcp.example.test');
    act(() => {
      useMcpStore.getState().appendLog(id, {
        method: 'tools/call',
        result: { content: [{ type: 'text', text: 'hello' }] },
        durationMs: 7,
      });
    });
    render(<McpResultPanel />);
    expect(await screen.findByTestId('editor')).toHaveTextContent('"text": "hello"');
    expect(screen.getByText('isError: false')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download result' })).toBeInTheDocument();
  });

  it('shows the error payload with isError: true', async () => {
    const id = useMcpStore.getState().createConnection('https://mcp.example.test');
    act(() => {
      useMcpStore.getState().appendLog(id, { method: 'tools/call', error: 'boom', durationMs: 3 });
    });
    render(<McpResultPanel />);
    expect(await screen.findByTestId('editor')).toHaveTextContent('"error": "boom"');
    expect(screen.getByText('isError: true')).toBeInTheDocument();
  });
});
