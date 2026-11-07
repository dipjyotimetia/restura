import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/socketio/lib/emitWithVariables', () => ({
  replyAckWithVariables: vi.fn(() => ({ ok: true })),
}));

import { replyAckWithVariables } from '@/features/socketio/lib/emitWithVariables';
import { type SocketIOEvent, useSocketIOStore } from '@/features/socketio/store/useSocketIOStore';
import { SocketIOAckReply, SocketIOEmitOptionsMenu } from '../SocketIOAckControls';

const event = (patch: Partial<SocketIOEvent> = {}): SocketIOEvent => ({
  id: 'e1',
  direction: 'received',
  eventName: 'ask',
  args: [],
  timestamp: 0,
  serverAckId: 'srv-1',
  ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  useSocketIOStore.setState({ connections: {}, connectionByTabId: {} });
});

describe('SocketIOAckReply', () => {
  it('renders nothing for an event without a server ack request', () => {
    const { container } = render(
      <SocketIOAckReply connectionId="c" event={event({ serverAckId: undefined })} isConnected />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a confirmation once the ack was answered', () => {
    render(
      <SocketIOAckReply connectionId="c" event={event({ serverAckReplied: true })} isConnected />
    );
    expect(screen.getByText('Acknowledgement sent.')).toBeInTheDocument();
    expect(screen.queryByTestId('socketio-ack-reply')).toBeNull();
  });

  it('is disabled while disconnected', () => {
    render(<SocketIOAckReply connectionId="c" event={event()} isConnected={false} />);
    expect(
      screen.getByRole('textbox', { name: 'Acknowledgement arguments (JSON)' })
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: /Send ack/ })).toBeDisabled();
  });

  it('sends the typed args on click and on Enter, surfacing JSON errors', () => {
    render(<SocketIOAckReply connectionId="c" event={event()} isConnected />);
    const input = screen.getByRole('textbox', { name: 'Acknowledgement arguments (JSON)' });
    expect(input).toHaveValue('"ok"');
    fireEvent.change(input, { target: { value: '[{"status":"done"}]' } });
    fireEvent.click(screen.getByRole('button', { name: /Send ack/ }));
    expect(replyAckWithVariables).toHaveBeenLastCalledWith('c', 'srv-1', '[{"status":"done"}]');

    vi.mocked(replyAckWithVariables).mockReturnValueOnce({ ok: false, error: 'bad json' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('JSON error: bad json')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'a' });
    expect(replyAckWithVariables).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(replyAckWithVariables).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/JSON error/)).toBeNull();
  });
});

describe('SocketIOEmitOptionsMenu', () => {
  function setup(options = { volatile: false, compress: true, ackTimeoutMs: 15_000 }) {
    const id = useSocketIOStore.getState().createConnection('https://srv');
    useSocketIOStore.getState().updateConnectionField(id, 'emitOptions', options);
    function Harness() {
      const opts = useSocketIOStore((s) => s.connections[id]!.emitOptions);
      return <SocketIOEmitOptionsMenu connectionId={id} options={opts} />;
    }
    const utils = render(<Harness />);
    const current = () => useSocketIOStore.getState().connections[id]!.emitOptions;
    return { ...utils, current };
  }

  it('marks the trigger only when a non-default modifier is set', () => {
    const { container, current } = setup();
    const trigger = screen.getByRole('button', { name: 'Emit options' });
    expect(trigger.querySelector('span[aria-hidden="true"]')).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('switch', { name: 'Volatile emit' }));
    expect(current().volatile).toBe(true);
    expect(
      container.querySelector('button[aria-label="Emit options"] span[aria-hidden="true"]')
    ).not.toBeNull();
  });

  it('toggles compress and clamps the ack timeout', () => {
    const { current } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Emit options' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Compress emit' }));
    expect(current().compress).toBe(false);

    const timeout = screen.getByLabelText('Ack timeout (ms)');
    fireEvent.change(timeout, { target: { value: '2500.4' } });
    expect(current().ackTimeoutMs).toBe(2500);
    fireEvent.change(timeout, { target: { value: '999999' } });
    expect(current().ackTimeoutMs).toBe(60_000);
    fireEvent.change(timeout, { target: { value: '-5' } });
    expect(current().ackTimeoutMs).toBe(1);
    fireEvent.change(timeout, { target: { value: '' } });
    expect(current().ackTimeoutMs).toBe(1);
    expect(screen.getByText(/Binary args/)).toBeInTheDocument();
  });

  it('shows the marker for compress off', () => {
    setup({ volatile: false, compress: false, ackTimeoutMs: 100 });
    const trigger = screen.getByRole('button', { name: 'Emit options' });
    expect(trigger.querySelector('span[aria-hidden="true"]')).not.toBeNull();
  });
});
