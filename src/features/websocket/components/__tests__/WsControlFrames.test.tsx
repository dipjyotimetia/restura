import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ electron: true }));
vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => platform.electron,
  getElectronAPI: () => undefined,
}));

import { WsDisconnectControl } from '../WsDisconnectControl';
import { WsPingControl } from '../WsPingControl';

beforeEach(() => {
  platform.electron = true;
});

describe('WsDisconnectControl (#915)', () => {
  it('disconnects with the default close frame from the main segment', async () => {
    const onDisconnect = vi.fn();
    render(<WsDisconnectControl onDisconnect={onDisconnect} />);
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledWith();
  });

  it('sends a custom code + reason and blocks RFC-invalid input', async () => {
    const onDisconnect = vi.fn();
    render(<WsDisconnectControl onDisconnect={onDisconnect} />);
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect with close code' }));

    const code = screen.getByLabelText('Code (1000 or 3000-4999)');
    await userEvent.clear(code);
    await userEvent.type(code, '1001');
    expect(screen.getByRole('alert')).toHaveTextContent('1000 or 3000-4999');
    expect(screen.getByRole('button', { name: 'Close with code' })).toBeDisabled();

    await userEvent.clear(code);
    await userEvent.type(code, '4000');
    await userEvent.type(screen.getByLabelText('Reason (optional)'), 'done');
    expect(screen.getByText('4/123 B')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close with code' }));
    expect(onDisconnect).toHaveBeenCalledWith({ code: 4000, reason: 'done' });
  });

  it('ignores a forced submit of an invalid close frame', async () => {
    const onDisconnect = vi.fn();
    render(<WsDisconnectControl onDisconnect={onDisconnect} />);
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect with close code' }));
    await userEvent.clear(screen.getByLabelText('Code (1000 or 3000-4999)'));
    fireEvent.submit(screen.getByRole('button', { name: 'Close with code' }).closest('form')!);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('omits an empty reason', async () => {
    const onDisconnect = vi.fn();
    render(<WsDisconnectControl onDisconnect={onDisconnect} />);
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect with close code' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close with code' }));
    expect(onDisconnect).toHaveBeenCalledWith({ code: 1000 });
  });
});

describe('WsPingControl (#919)', () => {
  it('sends an empty ping from the main segment on desktop', async () => {
    const onPing = vi.fn();
    render(<WsPingControl disabled={false} onPing={onPing} />);
    await userEvent.click(screen.getByRole('button', { name: /^Ping$/ }));
    expect(onPing).toHaveBeenCalledWith('');
  });

  it('sends a payload ping and rejects one over 125 bytes', async () => {
    const onPing = vi.fn();
    render(<WsPingControl disabled={false} onPing={onPing} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ping with payload' }));
    const input = screen.getByLabelText('Ping payload (optional)');

    await userEvent.click(input);
    await userEvent.paste('a'.repeat(126));
    expect(screen.getByRole('alert')).toHaveTextContent('125 bytes');
    expect(screen.getByRole('button', { name: 'Send ping' })).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, 'hey');
    await userEvent.click(screen.getByRole('button', { name: 'Send ping' }));
    expect(onPing).toHaveBeenCalledWith('hey');
  });

  it('ignores a forced submit of an oversized payload', async () => {
    const onPing = vi.fn();
    render(<WsPingControl disabled={false} onPing={onPing} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ping with payload' }));
    await userEvent.click(screen.getByLabelText('Ping payload (optional)'));
    await userEvent.paste('a'.repeat(126));
    fireEvent.submit(screen.getByRole('button', { name: 'Send ping' }).closest('form')!);
    expect(onPing).not.toHaveBeenCalled();
  });

  it('is disabled while the socket is not open', () => {
    render(<WsPingControl disabled onPing={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^Ping$/ })).toBeDisabled();
  });

  it('is disabled on web with an explanatory tooltip', () => {
    platform.electron = false;
    render(<WsPingControl disabled={false} onPing={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Send ping (desktop only)' })).toBeDisabled();
    expect(screen.getByTestId('ws-ping-web')).toHaveAttribute(
      'title',
      expect.stringMatching(/browser WebSocket API/)
    );
  });
});
