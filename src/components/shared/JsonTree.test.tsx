import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import JsonTree from './JsonTree';

const setup = (value: unknown) => {
  const user = userEvent.setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  render(<JsonTree value={value} />);
  return { user, writeText };
};

describe('JsonTree', () => {
  it('opens the first levels, collapses deeper ones, and toggles', async () => {
    const { user } = setup({ a: { b: { c: 1 } } });
    expect(screen.getByText('"b":')).toBeInTheDocument();
    expect(screen.queryByText('"c":')).not.toBeInTheDocument();
    expect(screen.getByText('{c}')).toBeInTheDocument();
    const expand = screen.getAllByRole('button', { name: 'Expand' });
    await user.click(expand[0] as HTMLElement);
    expect(screen.getByText('"c":')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Collapse' })[0] as HTMLElement);
    expect(screen.queryByText('"a":')).not.toBeInTheDocument();
  });

  it('copies a node’s JSONPath and its value', async () => {
    const { user, writeText } = setup({ 'content-type': 'json', list: [true, null, 2] });
    const row = screen.getByText('"content-type":').closest('[role="treeitem"]') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Copy path' }));
    expect(writeText).toHaveBeenLastCalledWith("$['content-type']");
    await user.click(within(row).getByRole('button', { name: 'Copy value' }));
    expect(writeText).toHaveBeenLastCalledWith('json');
    const list = screen.getByText('"list":').closest('[role="treeitem"]') as HTMLElement;
    await user.click(within(list).getAllByRole('button', { name: 'Copy value' })[0] as HTMLElement);
    expect(writeText).toHaveBeenLastCalledWith('[\n  true,\n  null,\n  2\n]');
  });

  it('pages large arrays', async () => {
    const { user } = setup(Array.from({ length: 150 }, (_, i) => i));
    expect(screen.getByRole('button', { name: 'Show 50 more of 50' })).toBeInTheDocument();
    expect(screen.queryByText('149:')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show 50 more of 50' }));
    expect(screen.getByText('149:')).toBeInTheDocument();
  });
});
