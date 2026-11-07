import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpMethod } from '@/types';

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMocks }));

import { UrlBar } from '../UrlBar';

function renderUrlBar(url: string) {
  const props = {
    method: 'GET' as HttpMethod,
    url,
    isLoading: false,
    onMethodChange: vi.fn(),
    onUrlChange: vi.fn(),
    onSend: vi.fn(),
    onCancel: vi.fn(),
    onOpenCodeGen: vi.fn(),
  };
  return { props, ...render(<UrlBar {...props} />) };
}

describe('UrlBar feedback', () => {
  beforeEach(() => {
    toastMocks.success.mockReset();
    toastMocks.error.mockReset();
  });

  it('validates the URL it is given on mount, with a specific message (H8)', () => {
    renderUrlBar('ftp://example.com');
    expect(screen.getByRole('alert')).toHaveTextContent(/ftp:/);
    expect(screen.getByRole('button', { name: /send request/i })).toBeDisabled();
  });

  it('re-validates when the url prop changes (H8)', () => {
    const { props, rerender } = renderUrlBar('https://example.com');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    rerender(<UrlBar {...props} url="https://example.com:70000" />);
    expect(screen.getByRole('alert')).toHaveTextContent(/port "70000"/i);
    rerender(<UrlBar {...props} url="https://example.com/ok" />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('names spaces while typing (H8)', () => {
    renderUrlBar('');
    fireEvent.change(screen.getByRole('textbox', { name: 'Request URL' }), {
      target: { value: 'https://exa mple.com/a' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/space/i);
  });

  it('confirms Copy URL with a toast (H9)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderUrlBar('https://example.com');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
    });
    expect(writeText).toHaveBeenCalledWith('https://example.com');
    expect(toastMocks.success).toHaveBeenCalledWith('URL copied');
  });

  it('reports a failed copy (H9)', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderUrlBar('https://example.com');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));
    });
    expect(toastMocks.error).toHaveBeenCalled();
  });
});
