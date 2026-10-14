import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRequestStore } from '@/store/useRequestStore';
import type { GrpcRequest, GrpcResponse } from '@/types';
import { useGrpcViolationFocus, useSubTabWithViolationJump } from '../../lib/grpcViolationFocus';
import { FIELD_VIOLATION_MARKER_OWNER, GrpcMessageEditor } from '../GrpcMessageEditor';

// A Monaco stand-in: just enough model/editor surface for markers + jumps.
function makeMonaco(text: string) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const model = {
    getPositionAt(offset: number) {
      let line = 0;
      while (line + 1 < lineStarts.length && (lineStarts[line + 1] ?? 0) <= offset) line++;
      return { lineNumber: line + 1, column: offset - (lineStarts[line] ?? 0) + 1 };
    },
  };
  const editor = { revealRangeInCenter: vi.fn(), setSelection: vi.fn(), focus: vi.fn() };
  const monaco = { MarkerSeverity: { Error: 8 }, editor: { setModelMarkers: vi.fn() } };
  return { model, editor, monaco };
}

let fake = makeMonaco('');

vi.mock('@/lib/shared/lazyComponent', () => ({
  lazyComponent: () =>
    function FakeEditor(props: {
      value: string;
      onModelChange?: (editor: unknown, monaco: unknown, model: unknown) => void;
    }) {
      const { onModelChange } = props;
      useEffect(() => {
        onModelChange?.(fake.editor, fake.monaco, fake.model);
      }, [onModelChange]);
      return <pre data-testid="editor">{props.value}</pre>;
    },
}));

const MESSAGE = `{
  "book": {
    "displayName": "",
    "authors": [{ "givenName": "Ann", "emailAddress": "bad" }]
  }
}`;

const request: GrpcRequest = {
  id: 'req',
  name: 'Create',
  type: 'grpc',
  methodType: 'unary',
  url: 'https://x.example.com',
  service: 'lib.v1.Library',
  method: 'CreateBook',
  metadata: [],
  message: MESSAGE,
  auth: { type: 'none' },
};

const errorResponse: GrpcResponse = {
  id: 'res',
  requestId: 'req',
  status: 3,
  statusText: 'INVALID_ARGUMENT',
  headers: {},
  body: '{}',
  size: 2,
  time: 1,
  timestamp: 0,
  grpcStatus: 3,
  grpcStatusText: 'INVALID_ARGUMENT',
  trailers: {},
  statusDetails: [
    {
      type: 'google.rpc.BadRequest',
      value: {
        fieldViolations: [
          { field: 'book.display_name', description: 'must not be empty' },
          { field: 'book.authors[0].email_address', description: 'invalid email' },
        ],
      },
    },
  ],
};

function setActive(response: GrpcResponse | null) {
  useRequestStore.setState({
    tabs: [{ id: 'tab', request, response }] as never,
    activeTabId: 'tab',
  });
}

describe('GrpcMessageEditor field-violation diagnostics (#941)', () => {
  beforeEach(() => {
    fake = makeMonaco(MESSAGE);
    useGrpcViolationFocus.setState({ pending: null });
  });

  it('sets one error marker per violation at the offending "key": value', async () => {
    setActive(errorResponse);
    render(<GrpcMessageEditor value={MESSAGE} onChange={() => {}} isValid modelOwner="tab" />);
    await waitFor(() => expect(fake.monaco.editor.setModelMarkers).toHaveBeenCalled());
    const calls = fake.monaco.editor.setModelMarkers.mock.calls;
    const [, owner, markers] = calls[calls.length - 1] as [
      unknown,
      string,
      Array<Record<string, unknown>>,
    ];
    expect(owner).toBe(FIELD_VIOLATION_MARKER_OWNER);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      startLineNumber: 3,
      startColumn: 5,
      endLineNumber: 3,
      endColumn: 22, // `"displayName": ""`
      severity: 8,
      message: 'book.display_name: must not be empty',
    });
    expect(markers[1]).toMatchObject({ startLineNumber: 4 });
    expect(screen.getByText(/The server rejected 2 fields/)).toBeInTheDocument();
  });

  it('clears markers when the active response has no violations', async () => {
    setActive({ ...errorResponse, grpcStatus: 0, statusDetails: undefined });
    render(<GrpcMessageEditor value={MESSAGE} onChange={() => {}} isValid modelOwner="tab" />);
    await waitFor(() => expect(fake.monaco.editor.setModelMarkers).toHaveBeenCalled());
    expect(fake.monaco.editor.setModelMarkers.mock.calls.at(-1)?.[2]).toEqual([]);
    expect(screen.queryByText(/The server rejected/)).not.toBeInTheDocument();
  });

  it('reveals + selects the violation on a jump request for its tab, then consumes it', async () => {
    setActive(errorResponse);
    render(<GrpcMessageEditor value={MESSAGE} onChange={() => {}} isValid modelOwner="tab" />);
    act(() => useGrpcViolationFocus.getState().focus('tab', 1));
    await waitFor(() => expect(fake.editor.revealRangeInCenter).toHaveBeenCalledOnce());
    expect(fake.editor.setSelection).toHaveBeenCalledWith(
      expect.objectContaining({ startLineNumber: 4 })
    );
    expect(fake.editor.focus).toHaveBeenCalled();
    expect(useGrpcViolationFocus.getState().pending).toBeNull();
  });

  it('ignores a jump request aimed at another tab', async () => {
    setActive(errorResponse);
    render(<GrpcMessageEditor value={MESSAGE} onChange={() => {}} isValid modelOwner="tab" />);
    act(() => useGrpcViolationFocus.getState().focus('other-tab', 0));
    await waitFor(() => expect(fake.monaco.editor.setModelMarkers).toHaveBeenCalled());
    expect(fake.editor.revealRangeInCenter).not.toHaveBeenCalled();
    expect(useGrpcViolationFocus.getState().pending).not.toBeNull();
  });
});

describe('useSubTabWithViolationJump', () => {
  it('switches back to the message tab when a jump targets this request tab', () => {
    useGrpcViolationFocus.setState({ pending: null });
    const { result } = renderHook(() =>
      useSubTabWithViolationJump<'message' | 'metadata'>('message', 'tab')
    );
    act(() => result.current[1]('metadata'));
    expect(result.current[0]).toBe('metadata');
    act(() => useGrpcViolationFocus.getState().focus('other', 0));
    expect(result.current[0]).toBe('metadata');
    act(() => useGrpcViolationFocus.getState().focus('tab', 0));
    expect(result.current[0]).toBe('message');
  });
});
