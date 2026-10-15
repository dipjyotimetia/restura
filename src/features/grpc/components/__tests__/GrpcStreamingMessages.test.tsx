import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GrpcStreamingMessages } from '../GrpcStreamingControls';

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
});
