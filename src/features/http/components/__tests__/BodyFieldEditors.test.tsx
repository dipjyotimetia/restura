import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { FormDataItem } from '@/types';

vi.mock('@/lib/shared/file-utils', async (orig) => ({
  ...(await orig<typeof import('@/lib/shared/file-utils')>()),
  // 'AAEC' decodes to 3 bytes.
  readFileAsBase64: vi.fn(async () => 'AAEC'),
}));

import BinaryBodyPicker from '../BinaryBodyPicker';
import FormDataEditor from '../FormDataEditor';
import UrlEncodedEditor from '../UrlEncodedEditor';

const field = (over: Partial<FormDataItem> = {}): FormDataItem => ({
  id: 'f1',
  key: 'name',
  value: 'Ada',
  enabled: true,
  type: 'text',
  ...over,
});

let latest: FormDataItem[] = [];
function Harness({
  Editor,
  initial,
}: {
  Editor: typeof FormDataEditor | typeof UrlEncodedEditor;
  initial: FormDataItem[];
}) {
  const [items, setItems] = useState(initial);
  latest = items;
  return <Editor items={items} onChange={setItems} />;
}

const pngFile = () => new File([new Uint8Array([0, 1, 2])], 'logo.png', { type: 'image/png' });

describe('UrlEncodedEditor', () => {
  it('edits, toggles, removes and adds fields in table mode', async () => {
    render(
      <Harness Editor={UrlEncodedEditor} initial={[field(), field({ id: 'f2', key: 'role' })]} />
    );
    fireEvent.change(screen.getByLabelText('Field 1 key'), { target: { value: 'user' } });
    fireEvent.change(screen.getByLabelText('Field 1 value'), { target: { value: 'Grace' } });
    expect(latest[0]).toMatchObject({ key: 'user', value: 'Grace' });

    await userEvent.click(screen.getByRole('switch', { name: 'Enable field 2' }));
    expect(latest[1]?.enabled).toBe(false);
    expect(screen.getByLabelText('Field 2 key').closest('tr')).toHaveClass('opacity-55');

    await userEvent.click(screen.getByRole('button', { name: 'Remove field 1' }));
    expect(latest.map((f) => f.key)).toEqual(['role']);

    await userEvent.click(screen.getByRole('button', { name: 'Add field' }));
    expect(latest).toHaveLength(2);
    expect(latest[1]).toMatchObject({ key: '', value: '', enabled: true, type: 'text' });
  });

  it('rebuilds enabled fields from the encoded text, keeping disabled ones', async () => {
    render(
      <Harness
        Editor={UrlEncodedEditor}
        initial={[field(), field({ id: 'off', key: 'hidden', value: 'x', enabled: false })]}
      />
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Text' }));
    const text = screen.getByLabelText('Encoded form body');
    expect(text).toHaveValue('name=Ada');

    fireEvent.change(text, { target: { value: 'a=1&b=two%20words&' } });
    // The draft keeps the trailing '&' while typing.
    expect(text).toHaveValue('a=1&b=two%20words&');
    expect(latest.map((f) => [f.key, f.value, f.enabled])).toEqual([
      ['a', '1', true],
      ['b', 'two words', true],
      ['hidden', 'x', false],
    ]);

    fireEvent.blur(text);
    expect(text).toHaveValue('a=1&b=two%20words');

    await userEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(screen.getByLabelText('Field 2 value')).toHaveValue('two words');
  });
});

describe('FormDataEditor', () => {
  it('shows an empty state and adds a text field', async () => {
    render(<Harness Editor={FormDataEditor} initial={[]} />);
    expect(screen.getByText('No fields added')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add field' }));
    expect(latest).toEqual([expect.objectContaining({ key: '', type: 'text', enabled: true })]);
    expect(screen.queryByText('No fields added')).not.toBeInTheDocument();
  });

  it('edits key, value and enabled state, and deletes a field', async () => {
    render(<Harness Editor={FormDataEditor} initial={[field()]} />);
    fireEvent.change(screen.getByLabelText('Field key'), { target: { value: 'who' } });
    fireEvent.change(screen.getByLabelText('Field value'), { target: { value: 'Lin' } });
    expect(latest[0]).toMatchObject({ key: 'who', value: 'Lin' });

    await userEvent.click(screen.getByRole('switch', { name: 'Disable field' }));
    expect(screen.getByRole('switch', { name: 'Enable field' })).not.toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Delete field' }));
    expect(latest).toEqual([]);
  });

  it('switching to file clears the value; picking a file stores base64 + metadata', async () => {
    render(<Harness Editor={FormDataEditor} initial={[field()]} />);
    const types = screen.getByRole('radiogroup', { name: 'Field type' });
    // Re-selecting the current type is a no-op.
    await userEvent.click(within(types).getByRole('radio', { name: 'text' }));
    expect(latest[0]?.value).toBe('Ada');

    await userEvent.click(within(types).getByRole('radio', { name: 'file' }));
    expect(latest[0]).toMatchObject({ type: 'file', value: '' });
    expect(screen.getByText('no file selected')).toBeInTheDocument();

    const input = screen.getByLabelText('Choose file', { selector: 'input' });
    await userEvent.upload(input, pngFile());
    await waitFor(() =>
      expect(latest[0]).toMatchObject({
        value: 'AAEC',
        fileName: 'logo.png',
        contentType: 'image/png',
      })
    );
    expect(screen.getByText('logo.png (3 B)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose file' })).toHaveTextContent('Replace');

    // Back to text drops the file metadata.
    await userEvent.click(within(types).getByRole('radio', { name: 'text' }));
    expect(latest[0]).not.toHaveProperty('fileName');
    expect(latest[0]).not.toHaveProperty('contentType');
    expect(latest[0]).toMatchObject({ type: 'text', value: '' });
  });

  it('defaults the content type for a typeless file and ignores an empty pick', async () => {
    render(<Harness Editor={FormDataEditor} initial={[field({ type: 'file', value: '' })]} />);
    const input = screen.getByLabelText('Choose file', { selector: 'input' });
    fireEvent.change(input, { target: { files: [] } });
    expect(latest[0]?.value).toBe('');

    await userEvent.upload(input, new File(['x'], 'blob.bin'));
    await waitFor(() => expect(latest[0]?.contentType).toBe('application/octet-stream'));
  });

  it('shows a stored file name without a size when it has no bytes', () => {
    render(
      <Harness
        Editor={FormDataEditor}
        initial={[field({ type: 'file', value: '', fileName: 'a.txt' })]}
      />
    );
    expect(screen.getByText('a.txt')).toHaveAttribute('title', 'a.txt');
  });

  it('opens the hidden file input from the Choose file button', async () => {
    render(<Harness Editor={FormDataEditor} initial={[field({ type: 'file', value: '' })]} />);
    const input = screen.getByLabelText('Choose file', { selector: 'input' });
    const click = vi.spyOn(input, 'click');
    await userEvent.click(screen.getByRole('button', { name: 'Choose file' }));
    expect(click).toHaveBeenCalled();
  });
});

describe('BinaryBodyPicker', () => {
  function BinaryHarness({ initial = '' }: { initial?: string }) {
    const [b64, setB64] = useState(initial);
    return (
      <>
        <BinaryBodyPicker base64={b64} onChange={setB64} />
        <output data-testid="b64">{b64}</output>
      </>
    );
  }

  it('prompts for a file when empty and opens the picker', async () => {
    render(<BinaryHarness />);
    expect(screen.getByText(/Choose a file to send/)).toBeInTheDocument();
    const input = screen.getByLabelText('Choose request body file');
    const click = vi.spyOn(input, 'click');
    await userEvent.click(screen.getByRole('button', { name: 'Choose file' }));
    expect(click).toHaveBeenCalled();
  });

  it('encodes a picked file, shows its name and size, and clears it', async () => {
    render(<BinaryHarness />);
    await userEvent.upload(screen.getByLabelText('Choose request body file'), pngFile());
    expect(await screen.findByText('3 B')).toBeInTheDocument();
    expect(screen.getByTestId('b64')).toHaveTextContent('AAEC');
    expect(screen.getByText(/logo\.png/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Replace file/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Clear binary body' }));
    expect(screen.getByTestId('b64')).toBeEmptyDOMElement();
    expect(screen.getByLabelText('Choose request body file')).toHaveValue('');
  });

  it('shows only the size for a stored body (name is not persisted) and ignores an empty pick', () => {
    render(<BinaryHarness initial="AAECAw==" />);
    // 'AAECAw==' decodes to 4 bytes.
    expect(screen.getByText('4 B')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Choose request body file'), { target: { files: [] } });
    expect(screen.getByTestId('b64')).toHaveTextContent('AAECAw==');
  });
});
