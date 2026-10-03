import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ResponseHeadersPanel } from './ResponseHeadersPanel';

const entries: Array<[string, string | string[]]> = [
  ['content-type', 'application/json'],
  ['set-cookie', ['a=1', 'b=2']],
];

describe('ResponseHeadersPanel', () => {
  const setup = () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(
      <TooltipProvider>
        <ResponseHeadersPanel entries={entries} />
      </TooltipProvider>
    );
    return { user, writeText };
  };

  it('filters by value and copies only the visible headers', async () => {
    const { user, writeText } = setup();
    await user.type(screen.getByLabelText('Filter response headers'), 'b=2');
    expect(screen.queryByText('content-type')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy 1' }));
    expect(writeText).toHaveBeenCalledWith('set-cookie: a=1\nset-cookie: b=2');
  });

  it('copies all headers and a single header', async () => {
    const { user, writeText } = setup();
    await user.click(screen.getByRole('button', { name: 'Copy all' }));
    expect(writeText).toHaveBeenLastCalledWith(
      'content-type: application/json\nset-cookie: a=1\nset-cookie: b=2'
    );
    await user.click(screen.getAllByRole('button', { name: 'Copy header' })[0] as HTMLElement);
    expect(writeText).toHaveBeenLastCalledWith('content-type: application/json');
  });

  it('says so when nothing matches', async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText('Filter response headers'), 'zzz');
    expect(screen.getByText(/No headers match/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy 0' })).toBeDisabled();
  });
});
