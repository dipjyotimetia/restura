import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, useConfirmDialog } from '../ConfirmDialog';

describe('ConfirmDialog', () => {
  it('uses default button labels and styling', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Proceed?"
        description="Something happens"
        onConfirm={onConfirm}
      />
    );
    expect(screen.getByRole('alertdialog', { name: 'Proceed?' })).toHaveTextContent(
      'Something happens'
    );
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).not.toHaveClass('bg-destructive');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('applies the destructive variant and custom labels', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete?"
        description="Gone forever"
        confirmText="Delete it"
        cancelText="Keep"
        variant="destructive"
        onConfirm={() => {}}
      />
    );
    expect(screen.getByRole('button', { name: 'Delete it' })).toHaveClass('bg-destructive');
    expect(screen.getByRole('button', { name: 'Keep' })).toBeInTheDocument();
  });
});

function Harness({ onResult }: { onResult: (value: boolean) => void }) {
  const [options] = useState({
    title: 'Send in cleartext?',
    description: 'Credentials travel unencrypted.',
    confirmText: 'Send anyway',
    variant: 'destructive' as const,
  });
  const { confirm, DialogComponent } = useConfirmDialog(options);
  return (
    <>
      <button type="button" onClick={() => void confirm().then(onResult)}>
        ask
      </button>
      <DialogComponent />
    </>
  );
}

describe('useConfirmDialog', () => {
  it('resolves true when confirmed', async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    render(<Harness onResult={onResult} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'ask' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Credentials travel unencrypted.');
    await user.click(screen.getByRole('button', { name: 'Send anyway' }));
    await act(async () => {});
    expect(onResult).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('resolves false when cancelled or dismissed', async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    render(<Harness onResult={onResult} />);
    await user.click(screen.getByRole('button', { name: 'ask' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {});
    expect(onResult).toHaveBeenLastCalledWith(false);

    await user.click(screen.getByRole('button', { name: 'ask' }));
    await user.keyboard('{Escape}');
    await act(async () => {});
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenLastCalledWith(false);
  });
});
