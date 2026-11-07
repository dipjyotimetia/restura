import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HttpRequest } from '@/types';
import { LoadTestDialog } from '../LoadTestDialog';

const start = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useLoadTest', () => ({
  useLoadTest: () => ({ running: false, progress: null, start, stop: vi.fn() }),
}));

const request: HttpRequest = {
  id: 'r',
  name: 'Ping',
  type: 'http',
  method: 'GET',
  url: 'https://example.com',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
};

describe('LoadTestDialog limits', () => {
  it('clamps typed values to the stated maximums and says so', () => {
    render(<LoadTestDialog request={request} open onClose={() => {}} />);
    const total = screen.getByRole('spinbutton', { name: 'Total requests' });
    const concurrency = screen.getByRole('spinbutton', { name: 'Concurrency' });

    fireEvent.change(total, { target: { value: '250000' } });
    fireEvent.change(concurrency, { target: { value: '9999' } });

    expect((total as HTMLInputElement).value).toBe('100000');
    expect((concurrency as HTMLInputElement).value).toBe('500');
    expect(screen.getByText('Capped at 100,000 requests.')).toBeTruthy();
    expect(screen.getByText('Capped at 500 concurrent requests.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /run/i }));
    expect(start).toHaveBeenCalledWith(request, { iterations: 100_000, concurrency: 500 });
  });
});
