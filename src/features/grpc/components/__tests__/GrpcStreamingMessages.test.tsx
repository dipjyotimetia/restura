import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GrpcStreamingMessages } from '../GrpcStreamingControls';

describe('GrpcStreamingMessages', () => {
  it('shows no dropped notice when nothing was evicted', () => {
    render(<GrpcStreamingMessages messages={['{"a":1}']} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('Message 1')).toBeTruthy();
  });

  it('says how many earlier messages were dropped and keeps absolute numbering', () => {
    render(<GrpcStreamingMessages messages={['{"n":4}', '{"n":5}']} dropped={3} />);
    expect(screen.getByRole('status').textContent).toMatch(/3 earlier messages dropped/);
    expect(screen.getByText('Streaming messages received: 5')).toBeTruthy();
    expect(screen.getByText('Message 4')).toBeTruthy();
    expect(screen.getByText('Message 5')).toBeTruthy();
  });

  it('still shows the dropped notice when no messages are retained', () => {
    render(<GrpcStreamingMessages messages={[]} dropped={1} />);
    expect(screen.getByRole('status').textContent).toMatch(/1 earlier message dropped/);
  });
});
