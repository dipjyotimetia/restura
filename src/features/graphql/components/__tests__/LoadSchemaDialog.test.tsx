import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MAX_SCHEMA_SOURCE_BYTES } from '../../lib/schemaImport';
import { LoadSchemaDialog } from '../LoadSchemaDialog';

const SDL = 'type Query {\n  hello: String\n}';

function setup() {
  const onLoad = vi.fn();
  const onOpenChange = vi.fn();
  render(<LoadSchemaDialog open onOpenChange={onOpenChange} onLoad={onLoad} />);
  const textarea = screen.getByLabelText(/Schema source/) as HTMLTextAreaElement;
  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  return { onLoad, onOpenChange, textarea, fileInput };
}

function chooseFile(input: HTMLInputElement, file: File) {
  fireEvent.change(input, { target: { files: [file] } });
}

describe('LoadSchemaDialog', () => {
  it('loads pasted SDL and clears the editor', () => {
    const { onLoad, textarea } = setup();
    fireEvent.change(textarea, { target: { value: SDL } });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({ sdl: SDL, source: 'sdl' }), 1);
    expect(textarea.value).toBe('');
  });

  it('shows the parse error for pasted text, and clears it once the user edits', () => {
    const { onLoad, textarea } = setup();
    fireEvent.change(textarea, { target: { value: 'type Query {' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    expect(onLoad).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/^Syntax Error/);

    fireEvent.change(textarea, { target: { value: SDL } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('loads a chosen schema file and records its name', async () => {
    const { onLoad, fileInput } = setup();
    chooseFile(fileInput, new File([SDL], 'api.graphqls'));

    await waitFor(() => expect(onLoad).toHaveBeenCalled());
    expect(onLoad.mock.calls[0]?.[0]).toMatchObject({ sdl: SDL, fileName: 'api.graphqls' });
  });

  it('prefixes a file parse error with the file name', async () => {
    const { onLoad, fileInput } = setup();
    chooseFile(fileInput, new File(['{ "not": "introspection" }'], 'dump.json'));

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /^dump\.json: JSON is not an introspection result/
    );
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('refuses an oversized file without reading it', async () => {
    const { onLoad, fileInput } = setup();
    const file = new File(['x'], 'huge.graphql');
    Object.defineProperty(file, 'size', { value: MAX_SCHEMA_SOURCE_BYTES + 1 });
    const text = vi.spyOn(file, 'text');
    chooseFile(fileInput, file);

    expect((await screen.findByRole('alert')).textContent).toBe(
      'huge.graphql: Schema is too large (max 20 MB).'
    );
    expect(text).not.toHaveBeenCalled();
    expect(onLoad).not.toHaveBeenCalled();
  });

  it.each([
    [new Error('permission denied'), 'Could not read locked.graphql: permission denied'],
    ['EIO', 'Could not read locked.graphql: EIO'],
  ])('reports a file that cannot be read (%s)', async (failure, message) => {
    const { fileInput } = setup();
    const file = new File([SDL], 'locked.graphql');
    vi.spyOn(file, 'text').mockRejectedValue(failure);
    chooseFile(fileInput, file);

    expect((await screen.findByRole('alert')).textContent).toBe(message);
  });

  it('ignores a change event with no file selected', () => {
    const { onLoad, fileInput } = setup();
    fireEvent.change(fileInput, { target: { files: [] } });
    expect(onLoad).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('resets the draft and error when the dialog is dismissed', () => {
    const { onOpenChange, textarea } = setup();
    fireEvent.change(textarea, { target: { value: 'type Query {' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(textarea.value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Cancel asks the parent to close', () => {
    const { onOpenChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
