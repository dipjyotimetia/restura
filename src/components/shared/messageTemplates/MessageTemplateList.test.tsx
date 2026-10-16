import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocketMessageTemplate } from '@/lib/shared/streaming/messageTemplates';
import { MessageTemplateList } from './MessageTemplateList';

const tpl = (id: string, name: string): WebSocketMessageTemplate => ({
  id,
  name,
  body: `{"id":"{{${id}}}"}`,
  format: 'json',
});

function Harness({
  initial,
  onLoad = vi.fn(),
  onSend = vi.fn(),
  canSend = true,
  create = () => tpl('new', 'Message 3'),
}: {
  initial: WebSocketMessageTemplate[];
  onLoad?: (t: WebSocketMessageTemplate) => void;
  onSend?: (t: WebSocketMessageTemplate) => void;
  canSend?: boolean;
  create?: () => WebSocketMessageTemplate | null;
}) {
  const [list, setList] = useState(initial);
  return (
    <>
      <MessageTemplateList
        templates={list}
        onChange={setList}
        onLoad={onLoad}
        onSend={onSend}
        createFromComposer={create}
        canSend={canSend}
        describe={(t) => `${t.format} · ${t.body}`}
        noun="message"
      />
      <output data-testid="order">{list.map((t) => t.name).join(',')}</output>
    </>
  );
}

describe('MessageTemplateList', () => {
  it('shows an empty state', () => {
    render(<Harness initial={[]} />);
    expect(screen.getByText(/No saved messages yet/)).toBeInTheDocument();
  });

  it('loads on click and sends via button or Shift+Enter', () => {
    const onLoad = vi.fn();
    const onSend = vi.fn();
    render(<Harness initial={[tpl('a', 'Alpha')]} onLoad={onLoad} onSend={onSend} />);
    fireEvent.click(screen.getByTitle(/Load into composer/));
    expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send Alpha' }));
    fireEvent.keyDown(screen.getByTitle(/Load into composer/), { key: 'Enter', shiftKey: true });
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it('does not send via Shift+Enter when sending is disabled', () => {
    const onSend = vi.fn();
    render(<Harness initial={[tpl('a', 'Alpha')]} onSend={onSend} canSend={false} />);
    expect(screen.getByRole('button', { name: 'Send Alpha' })).toBeDisabled();
    fireEvent.keyDown(screen.getByTitle(/Load into composer/), { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('saves the composer, then renames inline', () => {
    render(<Harness initial={[tpl('a', 'Alpha')]} />);
    fireEvent.click(screen.getByRole('button', { name: /Save current/ }));
    const input = screen.getByRole('textbox', { name: 'Rename saved message' });
    fireEvent.change(input, { target: { value: 'Login' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('order').textContent).toBe('Alpha,Login');
  });

  it('ignores Save current when the composer has nothing to save', () => {
    render(<Harness initial={[]} create={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: /Save current/ }));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('cancels a rename with Escape and commits on blur', () => {
    render(<Harness initial={[tpl('a', 'Alpha')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename Alpha' }));
    let input = screen.getByRole('textbox', { name: 'Rename saved message' });
    fireEvent.change(input, { target: { value: 'Nope' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByTestId('order').textContent).toBe('Alpha');

    fireEvent.click(screen.getByRole('button', { name: 'Rename Alpha' }));
    input = screen.getByRole('textbox', { name: 'Rename saved message' });
    fireEvent.change(input, { target: { value: 'Beta' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('order').textContent).toBe('Beta');
  });

  it('reorders and deletes', () => {
    render(<Harness initial={[tpl('a', 'Alpha'), tpl('b', 'Bravo')]} />);
    expect(screen.getByRole('button', { name: 'Move Alpha up' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move Bravo up' }));
    expect(screen.getByTestId('order').textContent).toBe('Bravo,Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Move Bravo down' }));
    expect(screen.getByTestId('order').textContent).toBe('Alpha,Bravo');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Alpha' }));
    expect(screen.getByTestId('order').textContent).toBe('Bravo');
  });
});
