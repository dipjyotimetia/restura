import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import JsonTree from '../JsonTree';

const body = {
  data: {
    deep: { deeper: { leaf: 'x' } },
    list: Array.from({ length: 150 }, (_, i) => ({ id: i })),
  },
};

describe('JsonTree highlights and focus', () => {
  it('flags highlighted nodes and expands their ancestors', () => {
    render(
      <JsonTree
        value={body}
        highlights={[{ path: ['data', 'deep', 'deeper', 'leaf'], label: '[E] broke' }]}
      />
    );
    // depth 3 would normally start collapsed — the highlight keeps it open.
    const flag = screen.getByRole('img', { name: 'Error: [E] broke' });
    expect(flag.closest('[data-highlighted]')?.textContent).toContain('"leaf"');
  });

  it('jump-to pages and expands down to an out-of-view node and scrolls to it', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { rerender } = render(<JsonTree value={body} />);
    expect(screen.queryByText(/"id"/)).toBeNull();

    rerender(<JsonTree value={body} focus={{ path: ['data', 'list', 120, 'id'], nonce: 1 }} />);
    const target = screen.getByText('120', { selector: 'span' });
    expect(target.closest('[tabindex="-1"]')).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalled();
  });
});
