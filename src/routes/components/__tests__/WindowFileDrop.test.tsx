import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WindowFileDrop } from '../WindowFileDrop';

function dragEvent(type: string, init: { types?: string[]; files?: File[]; handled?: boolean }) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: init.types ?? ['Files'], files: init.files ?? [] },
  });
  if (init.handled) event.preventDefault();
  return event;
}

describe('WindowFileDrop', () => {
  it('shows an overlay while files are dragged and imports a dropped file', () => {
    const onFile = vi.fn();
    render(<WindowFileDrop onFile={onFile} />);
    act(() => {
      window.dispatchEvent(dragEvent('dragenter', {}));
    });
    expect(screen.getByText(/Drop to import/)).toBeInTheDocument();

    const over = dragEvent('dragover', {});
    window.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);

    const file = new File(['{}'], 'c.json');
    act(() => {
      window.dispatchEvent(dragEvent('drop', { files: [file] }));
    });
    expect(onFile).toHaveBeenCalledWith(file);
    expect(screen.queryByText(/Drop to import/)).toBeNull();
  });

  it('leaves drops an inner target handled, and ignores non-file drags', () => {
    const onFile = vi.fn();
    render(<WindowFileDrop onFile={onFile} />);
    act(() => {
      window.dispatchEvent(dragEvent('drop', { files: [new File(['x'], 'a.txt')], handled: true }));
      window.dispatchEvent(dragEvent('dragenter', { types: ['text/plain'] }));
    });
    expect(onFile).not.toHaveBeenCalled();
    expect(screen.queryByText(/Drop to import/)).toBeNull();

    act(() => {
      window.dispatchEvent(dragEvent('dragenter', {}));
      window.dispatchEvent(dragEvent('dragleave', {}));
    });
    expect(screen.queryByText(/Drop to import/)).toBeNull();
  });
});

describe('WindowFileDrop — non-file drops', () => {
  it('cancels a dropped link so the window never tries to navigate to it', () => {
    const onFile = vi.fn();
    render(<WindowFileDrop onFile={onFile} />);
    const over = dragEvent('dragover', { types: ['text/uri-list', 'text/plain'] });
    window.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    const drop = dragEvent('drop', { types: ['text/uri-list', 'text/plain'] });
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(onFile).not.toHaveBeenCalled();
    expect(screen.queryByText(/Drop to import/)).toBeNull();
  });

  it('leaves text/link drops into editable fields to the browser', () => {
    render(<WindowFileDrop onFile={vi.fn()} />);
    const input = document.createElement('input');
    document.body.appendChild(input);
    const over = dragEvent('dragover', { types: ['text/uri-list', 'text/plain'] });
    input.dispatchEvent(over);
    const drop = dragEvent('drop', { types: ['text/uri-list', 'text/plain'] });
    input.dispatchEvent(drop);
    expect(over.defaultPrevented).toBe(false);
    expect(drop.defaultPrevented).toBe(false);
    input.remove();
  });
});
