import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SseRequest } from '@/types';
import { SseCodeDialog } from '../SseCodeDialog';
import { SseUrlBar } from '../SseUrlBar';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe('SSE code generation (O-6)', () => {
  it('renders an EventSource snippet for the stream URL', () => {
    const request = {
      id: 'r1',
      name: 'Ticker',
      type: 'sse',
      url: 'https://stream.example.test/events',
      headers: [],
    } as unknown as SseRequest;
    render(<SseCodeDialog open onOpenChange={() => {}} request={request} />);
    const code = screen.getByText(/new EventSource/);
    expect(code.textContent).toContain('https://stream.example.test/events');
  });

  it('the URL bar shows a Generate code button when onCode is wired', () => {
    const onCode = vi.fn();
    render(
      <SseUrlBar
        url="https://stream.example.test/events"
        onUrlChange={vi.fn()}
        isStreaming={false}
        isConnecting={false}
        onStream={vi.fn()}
        onStop={vi.fn()}
        optionCount={0}
        headersOpen={false}
        onToggleHeaders={vi.fn()}
        onCode={onCode}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Generate code' }));
    expect(onCode).toHaveBeenCalledOnce();
  });
});
