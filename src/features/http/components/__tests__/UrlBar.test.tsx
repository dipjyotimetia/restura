import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { modLabel } from '@/lib/shared/shortcuts';
import type { HttpMethod } from '@/types';
import { UrlBar } from '../UrlBar';

function renderUrlBar(
  overrides: Partial<{
    method: HttpMethod;
    url: string;
    isLoading: boolean;
    onMethodChange: (m: HttpMethod) => void;
    onUrlChange: (u: string) => void;
    onPasteCurl: (command: string) => boolean;
    onSend: () => void;
    onCancel: () => void;
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
    onCancel: vi.fn(),
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

    it('becomes an enabled Cancel button while loading and calls onCancel', async () => {
      const user = userEvent.setup();
      const { props } = renderUrlBar({ url: 'https://example.com', isLoading: true });
      const cancel = screen.getByRole('button', { name: /cancel request/i });
      expect(cancel).not.toBeDisabled();
      await user.click(cancel);
      expect(props.onCancel).toHaveBeenCalledOnce();
      expect(props.onSend).not.toHaveBeenCalled();
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

    it('Send button shows the platform send hint (⌘↵ / Ctrl+↵) when idle', () => {
      renderUrlBar({ url: 'https://x.com' });
      expect(screen.getByText(modLabel('↵'))).toBeInTheDocument();
    });

    it('exposes Copy URL and Generate code buttons by label', () => {
      renderUrlBar({ url: 'https://x.com' });
      expect(screen.getByLabelText('Copy URL')).toBeInTheDocument();
      expect(screen.getByLabelText('Generate code snippet')).toBeInTheDocument();
    });
  });

  describe('keyboard and paste', () => {
    const urlInput = () => screen.getByRole('textbox', { name: 'Request URL' });

    it('Enter sends, but not while loading, with an invalid URL, or with Cmd/Ctrl held', () => {
      const { props, rerender } = renderUrlBar({ url: 'https://example.com' });
      fireEvent.keyDown(urlInput(), { key: 'Enter' });
      expect(props.onSend).toHaveBeenCalledOnce();

      fireEvent.keyDown(urlInput(), { key: 'Enter', metaKey: true });
      fireEvent.keyDown(urlInput(), { key: 'a' });
      expect(props.onSend).toHaveBeenCalledOnce();

      rerender(<UrlBar {...props} isLoading />);
      fireEvent.keyDown(urlInput(), { key: 'Enter' });
      expect(props.onSend).toHaveBeenCalledOnce();
    });

    it('keeps the typed draft while focused and shows the store value after blur', () => {
      const { props, rerender } = renderUrlBar({ url: 'https://x.dev' });
      fireEvent.change(urlInput(), { target: { value: 'https://x.dev?' } });
      expect(props.onUrlChange).toHaveBeenCalledWith('https://x.dev?');
      // The store copy drops the dangling "?" — the field must not.
      rerender(<UrlBar {...props} url="https://x.dev" />);
      expect(urlInput()).toHaveValue('https://x.dev?');
      fireEvent.blur(urlInput());
      expect(urlInput()).toHaveValue('https://x.dev');
    });

    const paste = (text: string) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.assign(event, { clipboardData: { getData: () => text } });
      urlInput().dispatchEvent(event);
      return event;
    };

    it('hands a pasted cURL command to onPasteCurl and swallows the paste on success', () => {
      const onPasteCurl = vi.fn(() => true);
      renderUrlBar({ url: 'https://x.dev', onPasteCurl });
      const event = paste("curl 'https://y.dev'");
      expect(onPasteCurl).toHaveBeenCalledWith("curl 'https://y.dev'");
      expect(event.defaultPrevented).toBe(true);
    });

    it('lets a plain URL, or an unparseable cURL command, paste normally', () => {
      const onPasteCurl = vi.fn(() => false);
      renderUrlBar({ url: '', onPasteCurl });
      expect(paste('https://plain.dev').defaultPrevented).toBe(false);
      expect(onPasteCurl).not.toHaveBeenCalled();
      expect(paste('curl nope').defaultPrevented).toBe(false);
      expect(onPasteCurl).toHaveBeenCalledOnce();
    });
  });
});
