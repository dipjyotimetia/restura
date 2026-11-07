import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketCodeButton, WebSocketCodeDialog } from '../WebSocketCodeDialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe('WebSocketCodeDialog (O-6)', () => {
  it('renders browser JS by default and Node.js with enabled handshake headers only', () => {
    render(
      <WebSocketCodeDialog
        open
        onOpenChange={() => {}}
        url="wss://echo.example.test/ws"
        protocols={['chat']}
        headers={[
          { id: '1', key: 'X-Team', value: 'core', enabled: true },
          { id: '2', key: 'X-Off', value: 'nope', enabled: false },
        ]}
        sampleMessage='{"hi":1}'
      />
    );
    expect(screen.getByText(/new WebSocket/).textContent).toContain('wss://echo.example.test/ws');
    fireEvent.click(screen.getByRole('radio', { name: 'Node.js (ws)' }));
    const node = screen.getByText(/require\('ws'\)|from 'ws'/);
    expect(node.textContent).toContain('X-Team');
    expect(node.textContent).not.toContain('X-Off');
  });

  it('the connection-bar button opens the dialog', () => {
    render(<WebSocketCodeButton url="wss://x.test" protocols={[]} headers={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate code' }));
    expect(screen.getByText(/new WebSocket/)).toBeInTheDocument();
  });
});
