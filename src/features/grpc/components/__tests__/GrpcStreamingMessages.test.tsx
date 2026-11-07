import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GrpcStreamingControls, { GrpcStreamingMessages } from '../GrpcStreamingControls';

describe('GrpcStreamingMessages', () => {
  it('shows no dropped notice when nothing was evicted', () => {
    render(<GrpcStreamingMessages messages={['{"a":1}']} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('Message 1')).toBeTruthy();
  });

  it('says how many messages were dropped and keeps absolute numbering', () => {
    render(<GrpcStreamingMessages messages={['{"n":4}', '{"n":5}']} dropped={3} />);
    expect(screen.getByRole('status').textContent).toMatch(/3 messages dropped/);
    expect(screen.getByText('Streaming messages received: 5')).toBeTruthy();
    expect(screen.getByText('Message 4')).toBeTruthy();
    expect(screen.getByText('Message 5')).toBeTruthy();
  });

  it('still shows the dropped notice when no messages are retained', () => {
    render(<GrpcStreamingMessages messages={[]} dropped={1} />);
    expect(screen.getByRole('status').textContent).toMatch(/1 message dropped/);
  });

  it('labels messages by original position when an oversized one left a gap', () => {
    render(
      <GrpcStreamingMessages
        messages={['{"n":1}', '{"n":2}', '{"n":4}']}
        dropped={1}
        positions={[1, 2, 4]}
      />
    );
    expect(screen.getByText('Message 1')).toBeTruthy();
    expect(screen.getByText('Message 2')).toBeTruthy();
    expect(screen.getByText('Message 4')).toBeTruthy();
    expect(screen.queryByText('Message 3')).toBeNull();
    expect(screen.getByText('Streaming messages received: 4')).toBeTruthy();
  });

  it('has the shared log tools: search, clear, freeze', () => {
    const onClear = vi.fn();
    const { rerender } = render(
      <GrpcStreamingMessages messages={['{"n":"alpha"}', '{"n":"beta"}']} onClear={onClear} />
    );
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search messages' }), {
      target: { value: 'beta' },
    });
    expect(screen.queryByText('Message 1')).toBeNull();
    expect(screen.getByText('Message 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear messages' }));
    expect(onClear).toHaveBeenCalled();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search messages' }), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Freeze message view' }));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
    rerender(
      <GrpcStreamingMessages
        messages={['{"n":"alpha"}', '{"n":"beta"}', '{"n":"gamma"}']}
        onClear={onClear}
      />
    );
    expect(screen.queryByText('Message 3')).toBeNull();
    expect(screen.getByText('1 new')).toBeTruthy();
    vi.restoreAllMocks();
  });
});

describe('GrpcStreamingControls', () => {
  const control = () => ({ sendMessage: vi.fn(), endStream: vi.fn(), cancelStream: vi.fn() });

  it('shows the JSON parser error as text, wired to the input', () => {
    render(
      <GrpcStreamingControls
        streamControl={control()}
        methodType="bidirectional-streaming"
        onCancel={vi.fn()}
      />
    );
    const box = screen.getByRole('textbox', { name: 'Stream message JSON' });
    fireEvent.change(box, { target: { value: '{ bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/^Invalid JSON — message not sent: .+/);
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(box.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('Cmd/Ctrl+Enter in the message box sends it', () => {
    const c = control();
    render(
      <GrpcStreamingControls streamControl={c} methodType="client-streaming" onCancel={vi.fn()} />
    );
    const box = screen.getByRole('textbox', { name: 'Stream message JSON' });
    fireEvent.change(box, { target: { value: '{"a":1}' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(c.sendMessage).toHaveBeenCalledWith({ a: 1 });
  });
});
