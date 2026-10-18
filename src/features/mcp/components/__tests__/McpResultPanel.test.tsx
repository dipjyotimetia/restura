import { act, fireEvent, render, screen } from '@testing-library/react';
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

  it('labels a JSON-RPC/transport failure as a PROTOCOL ERROR', async () => {
    const id = useMcpStore.getState().createConnection('https://mcp.example.test');
    act(() => {
      useMcpStore.getState().appendLog(id, { method: 'tools/call', error: 'boom', durationMs: 3 });
    });
    render(<McpResultPanel />);
    expect(await screen.findByTestId('editor')).toHaveTextContent('"error": "boom"');
    expect(screen.getByText('PROTOCOL ERROR')).toBeInTheDocument();
    expect(screen.queryByText(/TOOL ERROR/)).not.toBeInTheDocument();
  });

  it('shows a red TOOL ERROR badge for a successful response with result.isError: true (#868)', async () => {
    const id = useMcpStore.getState().createConnection('https://mcp.example.test');
    act(() => {
      useMcpStore.getState().appendLog(id, {
        method: 'tools/call:fail',
        result: { isError: true, content: [{ type: 'text', text: 'disk full' }] },
        durationMs: 3,
      });
    });
    render(<McpResultPanel />);
    const badge = screen.getByText('TOOL ERROR · isError: true');
    expect(badge).toHaveStyle({ color: 'var(--color-danger)' });
    expect(screen.queryByText('isError: false')).not.toBeInTheDocument();
    expect(screen.queryByText('PROTOCOL ERROR')).not.toBeInTheDocument();
    expect(await screen.findByTestId('editor')).toHaveTextContent('disk full');
  });

  it('includes the jsonRpcError, formats KB sizes, and toggles back to the full result', async () => {
    const id = useMcpStore.getState().createConnection('https://mcp.example.test');
    act(() => {
      useMcpStore.getState().appendLog(id, {
        method: 'tools/call:big',
        result: { content: [], structuredContent: { blob: 'x'.repeat(2000) } },
        durationMs: 1,
      });
    });
    const { unmount } = render(<McpResultPanel />);
    expect(screen.getByText(/KB$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show structuredContent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show full result' }));
    expect(await screen.findByTestId('editor')).toHaveTextContent('"content"');
    unmount();
    act(() => {
      useMcpStore.getState().appendLog(id, {
        method: 'tools/call:x',
        error: 'rpc',
        jsonRpcError: { code: -32602, message: 'bad params' },
        durationMs: 1,
      });
    });
    render(<McpResultPanel />);
    expect(await screen.findByTestId('editor')).toHaveTextContent('-32602');
  });

  describe('structuredContent vs outputSchema (#880)', () => {
    function setup(structuredContent: unknown) {
      const id = useMcpStore.getState().createConnection('https://mcp.example.test');
      act(() => {
        useMcpStore.getState().setCapabilities(id, {
          tools: [
            {
              name: 'count',
              outputSchema: {
                type: 'object',
                required: ['n'],
                properties: { n: { type: 'integer' } },
              },
            },
          ],
          resources: [],
          prompts: [],
        });
        useMcpStore.getState().appendLog(id, {
          method: 'tools/call:count',
          result: { content: [], structuredContent },
          durationMs: 1,
        });
      });
      render(<McpResultPanel />);
    }

    it('confirms a conforming structuredContent and can show it on its own', async () => {
      setup({ n: 3 });
      expect(screen.getByTestId('mcp-output-schema-ok')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Show structuredContent' }));
      expect(await screen.findByTestId('editor')).toHaveTextContent(/^\{\s*"n": 3\s*\}$/);
    });

    it('does not flag a schema violation on a protocol error', () => {
      const id = useMcpStore.getState().createConnection('https://mcp.example.test');
      act(() => {
        useMcpStore.getState().setCapabilities(id, {
          tools: [{ name: 'count', outputSchema: { type: 'object', required: ['n'] } }],
          resources: [],
          prompts: [],
        });
        useMcpStore.getState().appendLog(id, {
          method: 'tools/call:count',
          error: 'boom',
          durationMs: 1,
        });
      });
      render(<McpResultPanel />);
      expect(screen.getByText('PROTOCOL ERROR')).toBeInTheDocument();
      expect(screen.queryByTestId('mcp-output-schema-issues')).not.toBeInTheDocument();
    });

    it('notes when the outputSchema is too complex to validate', () => {
      const id = useMcpStore.getState().createConnection('https://mcp.example.test');
      act(() => {
        useMcpStore.getState().setCapabilities(id, {
          tools: [
            {
              name: 'count',
              outputSchema: { allOf: Array.from({ length: 40 }, () => ({ type: 'object' })) },
            },
          ],
          resources: [],
          prompts: [],
        });
        useMcpStore.getState().appendLog(id, {
          method: 'tools/call:count',
          result: { content: [], structuredContent: {} },
          durationMs: 1,
        });
      });
      render(<McpResultPanel />);
      expect(screen.getByTestId('mcp-output-schema-skipped')).toBeInTheDocument();
    });

    it('flags a structuredContent that violates the outputSchema', () => {
      setup({ n: 'three' });
      const alert = screen.getByTestId('mcp-output-schema-issues');
      expect(alert).toHaveTextContent('does not match');
      expect(alert).toHaveTextContent('$.n: expected integer, got string');
    });
  });
});
