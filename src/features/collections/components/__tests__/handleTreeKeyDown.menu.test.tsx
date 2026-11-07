import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { handleTreeKeyDown } from '../CollectionTree';

function Tree() {
  const actions = { toggleCollapse: vi.fn(), startRename: vi.fn(), deleteItem: vi.fn() };
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: test harness for the container handler
    <div role="tree" onKeyDown={(e) => handleTreeKeyDown(e, actions, new Set())}>
      <div role="treeitem" data-tree-row data-item-id="a" data-item-type="collection" tabIndex={-1}>
        A
      </div>
      <div role="treeitem" data-tree-row data-item-id="b" data-item-type="collection" tabIndex={0}>
        B
      </div>
      {/* stands in for a dropdown menu item rendered inside the tree */}
      <button type="button">Menu item</button>
    </div>
  );
}

describe('handleTreeKeyDown', () => {
  it('ignores arrow keys from a menu inside the tree (keeps the roving tab stop)', () => {
    render(<Tree />);
    const menuItem = screen.getByRole('button', { name: 'Menu item' });
    menuItem.focus();
    fireEvent.keyDown(menuItem, { key: 'Home' });
    expect(screen.getByText('B')).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('A')).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(menuItem);
  });

  it('still navigates when a row has focus', () => {
    render(<Tree />);
    const b = screen.getByText('B');
    b.focus();
    fireEvent.keyDown(b, { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByText('A'));
  });
});
