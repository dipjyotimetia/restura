import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { grpcResultText } from '@/features/grpc/components/GrpcResponsePanel';
import { JsonBodyView, parseJsonBody } from './JsonBodyView';

vi.mock('@/components/shared/CodeEditor', () => ({
  default: ({ value, language }: { value: string; language: string }) => (
    <pre data-testid="editor" data-language={language}>
      {value}
    </pre>
  ),
}));

afterEach(() => vi.restoreAllMocks());

describe('parseJsonBody', () => {
  it('parses JSON and rejects non-JSON', () => {
    expect(parseJsonBody('{"a":1}')).toEqual({ value: { a: 1 } });
    expect(parseJsonBody('not json')).toBeUndefined();
  });
});

describe('grpcResultText', () => {
  it('joins streamed frames into a JSON array, else returns the body', () => {
    expect(grpcResultText({ body: '', messages: ['{"n":1}', '{"n":2}'] })).toBe(
      '[{"n":1},{"n":2}]'
    );
    expect(grpcResultText({ body: '{"ok":true}' })).toBe('{"ok":true}');
  });
});

describe('JsonBodyView', () => {
  it('pretty-prints JSON, switches to raw, and shows a tree', async () => {
    render(<JsonBodyView text='{"a":{"b":1}}' downloadName="r" />);
    expect(await screen.findByTestId('editor')).toHaveTextContent('"b": 1');
    expect(screen.getByTestId('editor')).toHaveAttribute('data-language', 'json');

    await userEvent.click(screen.getByRole('radio', { name: 'Raw' }));
    expect(screen.getByTestId('editor').textContent).toBe('{"a":{"b":1}}');

    await userEvent.click(screen.getByRole('radio', { name: 'Tree' }));
    expect(await screen.findByRole('tree', { name: 'JSON response' })).toBeInTheDocument();
  });

  it('offers no tree or JSONPath for plain text', async () => {
    render(<JsonBodyView text="plain" downloadName="r" />);
    expect(await screen.findByTestId('editor')).toHaveAttribute('data-language', 'plaintext');
    expect(screen.queryByRole('radio', { name: 'Tree' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Query with JSONPath' })).toBeNull();
  });

  it('copies the shown text and downloads a named .json file', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    let downloaded = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      downloaded = this.download;
    });

    render(<JsonBodyView text='{"a":1}' downloadName="echo-response" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy result' }));
    expect(writeText).toHaveBeenCalledWith('{\n  "a": 1\n}');
    await userEvent.click(screen.getByRole('button', { name: 'Download result' }));
    expect(downloaded).toBe('echo-response.json');
  });
});
