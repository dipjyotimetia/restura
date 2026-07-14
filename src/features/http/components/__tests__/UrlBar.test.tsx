import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { HttpMethod } from '@/types';
import { UrlBar } from '../UrlBar';

function renderUrlBar(
  overrides: Partial<{
    method: HttpMethod;
    url: string;
    isLoading: boolean;
    onMethodChange: (m: HttpMethod) => void;
    onUrlChange: (u: string) => void;
    onSend: () => void;
    onOpenCodeGen: () => void;
  }> = {}
) {
  const props = {
    method: 'GET' as HttpMethod,
    url: '',
    isLoading: false,
    onMethodChange: vi.fn(),
    onUrlChange: vi.fn(),
    onSend: vi.fn(),
    onOpenCodeGen: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<UrlBar {...props} />) };
}

describe('UrlBar', () => {
  describe('Send button enabled/disabled', () => {
    it('is disabled when url is empty', () => {
      renderUrlBar({ url: '' });
      const send = screen.getByRole('button', { name: /send request/i });
      expect(send).toBeDisabled();
    });

    it('is disabled while loading', () => {
      renderUrlBar({ url: 'https://example.com', isLoading: true });
      const send = screen.getByRole('button', { name: /sending request/i });
      expect(send).toBeDisabled();
    });

    it('is enabled with a valid URL', () => {
      renderUrlBar({ url: 'https://example.com' });
      const send = screen.getByRole('button', { name: /send request/i });
      expect(send).not.toBeDisabled();
    });

    it('calls onSend when clicked', async () => {
      const user = userEvent.setup();
      const { props } = renderUrlBar({ url: 'https://example.com' });
      await user.click(screen.getByRole('button', { name: /send request/i }));
      expect(props.onSend).toHaveBeenCalledOnce();
    });
  });

  describe('URL input', () => {
    it('emits onUrlChange when typed', () => {
      const { props } = renderUrlBar();
      const input = screen.getByLabelText('Request URL') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'https://api.example.com' } });
      expect(props.onUrlChange).toHaveBeenCalledWith('https://api.example.com');
    });

    it('marks input aria-invalid when URL is malformed', async () => {
      const { rerender, props } = renderUrlBar({ url: 'https://x.com' });
      const input = screen.getByLabelText('Request URL') as HTMLInputElement;
      // Trigger internal validation by typing a manifestly invalid URL.
      // The component validates via new URL(); 'http://' alone throws.
      fireEvent.change(input, { target: { value: 'http://' } });
      // Re-render with the new url since the component is controlled.
      rerender(<UrlBar {...props} url="http://" />);
      expect(input).toHaveAttribute('aria-invalid', 'true');
    });
  });

  describe('Variable overlay (regex guard)', () => {
    function isInputTransparent(input: HTMLInputElement): boolean {
      return input.className.includes('text-transparent');
    }

    it('does NOT activate overlay when only `{{` is present', () => {
      renderUrlBar({ url: 'https://x.com/{{' });
      const input = screen.getByLabelText('Request URL') as HTMLInputElement;
      expect(isInputTransparent(input)).toBe(false);
    });

    it('does NOT activate overlay when only `}}` is present', () => {
      renderUrlBar({ url: 'https://x.com/}}' });
      const input = screen.getByLabelText('Request URL') as HTMLInputElement;
      expect(isInputTransparent(input)).toBe(false);
    });

    it('does NOT activate overlay for empty braces `{{ }}`', () => {
      renderUrlBar({ url: 'https://x.com/{{ }}' });
      const input = screen.getByLabelText('Request URL') as HTMLInputElement;
      expect(isInputTransparent(input)).toBe(false);
    });

    it('activates overlay for a valid `{{name}}` template', () => {
      renderUrlBar({ url: 'https://x.com/{{userId}}' });
      const input = screen.getByLabelText('Request URL') as HTMLInputElement;
      expect(isInputTransparent(input)).toBe(true);
    });

    it('accepts dots and dashes in variable names', () => {
      renderUrlBar({ url: 'https://x.com/{{user.id}}' });
      const input = screen.getByLabelText('Request URL') as HTMLInputElement;
      expect(isInputTransparent(input)).toBe(true);
    });
  });

  describe('Accessibility wiring', () => {
    it('exposes the URL input via aria-label', () => {
      renderUrlBar();
      expect(screen.getByLabelText('Request URL')).toBeInTheDocument();
    });

    it('Send button shows ⌘↵ keyboard hint when idle', () => {
      renderUrlBar({ url: 'https://x.com' });
      expect(screen.getByText('⌘↵')).toBeInTheDocument();
    });

    it('exposes Copy URL and Generate code buttons by label', () => {
      renderUrlBar({ url: 'https://x.com' });
      expect(screen.getByLabelText('Copy URL')).toBeInTheDocument();
      expect(screen.getByLabelText('Generate code snippet')).toBeInTheDocument();
    });
  });
});
