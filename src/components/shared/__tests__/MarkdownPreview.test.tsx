import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarkdownPreview, { untrustedUrlTransform } from '../MarkdownPreview';

describe('untrustedUrlTransform', () => {
  it('keeps absolute http(s) and mailto URLs', () => {
    expect(untrustedUrlTransform(' https://example.com/a ')).toBe('https://example.com/a');
    expect(untrustedUrlTransform('HTTP://x.test')).toBe('HTTP://x.test');
    expect(untrustedUrlTransform('mailto:a@b.test')).toBe('mailto:a@b.test');
  });

  it('blanks protocol-relative, relative, file and script URLs', () => {
    for (const url of ['//evil.test', '/local', 'docs.md', 'file:///etc/passwd', 'javascript:x']) {
      expect(untrustedUrlTransform(url)).toBe('');
    }
  });
});

describe('MarkdownPreview', () => {
  it('shows a placeholder for blank source', () => {
    render(<MarkdownPreview source={'  \n '} />);
    expect(screen.getByText('Nothing to preview yet.')).toBeInTheDocument();
  });

  it('trusted: renders links in a new tab and images as images', () => {
    const { container } = render(
      <MarkdownPreview source={'[docs](/guide) ![logo](https://x.test/l.png)'} />
    );
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('href', '/guide');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://x.test/l.png');
  });

  it('untrusted: keeps safe links nofollow and renders unsafe ones as inert text', () => {
    render(<MarkdownPreview untrusted source={'[ok](https://x.test) and [bad](//evil.test)'} />);
    const ok = screen.getByRole('link', { name: 'ok' });
    expect(ok).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(screen.queryByRole('link', { name: 'bad' })).not.toBeInTheDocument();
    expect(screen.getByText('bad').tagName).toBe('SPAN');
  });

  it('untrusted: never loads images, showing alt text instead', () => {
    const { container } = render(
      <MarkdownPreview
        untrusted
        source={'![secret](https://attacker.test/?d=1) ![](https://a/b)'}
      />
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('[image: secret]')).toBeInTheDocument();
    expect(screen.getByText('[image]')).toBeInTheDocument();
  });

  it('does not render raw HTML', () => {
    const { container } = render(<MarkdownPreview source={'<b id="x">hi</b>'} />);
    expect(container.querySelector('#x')).toBeNull();
  });
});
