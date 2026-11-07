import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { KeyValue } from '@/types';
import KeyValueEditor from '../KeyValueEditor';

type Row = KeyValue & { private?: boolean };

const row = (over: Partial<Row> = {}): Row => ({
  id: 'r1',
  key: 'token',
  value: 's3cret',
  enabled: true,
  ...over,
});

function Harness({
  initial,
  onAdd = () => {},
  onDelete = () => {},
  ...rest
}: {
  initial: Row[];
  onAdd?: () => void;
  onDelete?: (id: string) => void;
  enableSecrets?: boolean;
  enablePrivate?: boolean;
  itemType?: string;
  addButtonText?: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const [items, setItems] = useState(initial);
  return (
    <KeyValueEditor
      items={items}
      onAdd={onAdd}
      onDelete={onDelete}
      onUpdate={(id, updates) =>
        setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...updates } : i)))
      }
      {...rest}
    />
  );
}

describe('KeyValueEditor', () => {
  it('shows an empty state naming the item type and calls onAdd', async () => {
    const onAdd = vi.fn();
    render(<Harness initial={[]} itemType="variable" addButtonText="Add Variable" onAdd={onAdd} />);
    expect(screen.getByText('No variables added')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Add Variable/ }));
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it('uses default labels and placeholders', () => {
    render(<Harness initial={[row()]} />);
    expect(screen.getByRole('button', { name: /Add Item/ })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Key')).toHaveValue('token');
    expect(screen.getByPlaceholderText('Value')).toHaveValue('s3cret');
    expect(screen.queryByText(/No items added/)).not.toBeInTheDocument();
  });

  it('edits key and value through onUpdate', () => {
    render(
      <Harness initial={[row()]} itemType="header" keyPlaceholder="Name" valuePlaceholder="Val" />
    );
    fireEvent.change(screen.getByLabelText('header key'), { target: { value: 'X-Id' } });
    fireEvent.change(screen.getByLabelText('header value'), { target: { value: '42' } });
    expect(screen.getByPlaceholderText('Name')).toHaveValue('X-Id');
    expect(screen.getByPlaceholderText('Val')).toHaveValue('42');
  });

  it('toggles a row between enabled and disabled', async () => {
    render(<Harness initial={[row()]} itemType="header" />);
    await userEvent.click(screen.getByRole('switch', { name: 'Disable header' }));
    expect(screen.getByRole('switch', { name: 'Enable header' })).not.toBeChecked();
    await userEvent.click(screen.getByRole('switch', { name: 'Enable header' }));
    expect(screen.getByRole('switch', { name: 'Disable header' })).toBeChecked();
  });

  it('shows the toggle tooltip on hover', async () => {
    render(<Harness initial={[row({ enabled: false })]} itemType="header" />);
    await userEvent.hover(screen.getByRole('switch', { name: 'Enable header' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Enable header');
  });

  it('masks secret values until revealed, and hides the toggle for plain rows', async () => {
    render(<Harness initial={[row({ secret: true })]} enableSecrets />);
    const value = screen.getByLabelText('item value');
    expect(value).toHaveAttribute('type', 'password');

    await userEvent.click(screen.getByRole('button', { name: 'Reveal value' }));
    expect(value).toHaveAttribute('type', 'text');
    await userEvent.click(screen.getByRole('button', { name: 'Hide value' }));
    expect(value).toHaveAttribute('type', 'password');
  });

  it('marking and unmarking a secret updates the row and forgets the reveal', async () => {
    render(<Harness initial={[row()]} enableSecrets />);
    const value = screen.getByLabelText('item value');
    expect(value).toHaveAttribute('type', 'text');
    expect(screen.queryByRole('button', { name: 'Reveal value' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Mark as secret' }));
    expect(value).toHaveAttribute('type', 'password');
    await userEvent.click(screen.getByRole('button', { name: 'Reveal value' }));
    expect(value).toHaveAttribute('type', 'text');

    await userEvent.click(screen.getByRole('button', { name: 'Unmark as secret' }));
    expect(value).toHaveAttribute('type', 'text');
    // Re-marking starts masked again — the earlier reveal was dropped.
    await userEvent.click(screen.getByRole('button', { name: 'Mark as secret' }));
    expect(value).toHaveAttribute('type', 'password');
  });

  it('never masks when secrets are disabled', () => {
    render(<Harness initial={[row({ secret: true })]} />);
    expect(screen.getByLabelText('item value')).toHaveAttribute('type', 'text');
    expect(screen.queryByRole('button', { name: /secret/ })).not.toBeInTheDocument();
  });

  it('toggles the keep-local (private) flag', async () => {
    render(<Harness initial={[row()]} enablePrivate />);
    const keepLocal = screen.getByRole('button', { name: 'Keep local (exclude from export)' });
    expect(keepLocal).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(keepLocal);
    const include = screen.getByRole('button', { name: 'Include in export' });
    expect(include).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(include);
    expect(
      screen.getByRole('button', { name: 'Keep local (exclude from export)' })
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('explains a local-only row in its tooltip', async () => {
    render(<Harness initial={[row({ private: true })]} enablePrivate />);
    await userEvent.hover(screen.getByRole('button', { name: 'Include in export' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Local only — excluded from export and Git sync'
    );
  });

  it('confirms before deleting a row', async () => {
    const onDelete = vi.fn();
    render(<Harness initial={[row({ id: 'gone' })]} itemType="cookie" onDelete={onDelete} />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete cookie' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Delete Cookie')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Are you sure you want to delete this cookie\?/)
    ).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onDelete).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Delete cookie' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' })
    );
    expect(onDelete).toHaveBeenCalledWith('gone');
  });
});
