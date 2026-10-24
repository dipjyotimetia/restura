import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { flattenMcpArgumentFields, McpInvokeForm } from '@/features/mcp/components/McpInvokeForm';
import type { McpToolDescriptor } from '@/types';

const tool: McpToolDescriptor = {
  name: 'set-config',
  inputSchema: {
    type: 'object',
    required: ['attempts'],
    properties: {
      attempts: { type: 'integer', description: 'Retry count' },
      enabled: { type: 'boolean' },
      options: { type: 'object' },
    },
  },
};

describe('McpInvokeForm', () => {
  it('explains where server events appear when the Events tab is active', () => {
    render(
      <McpInvokeForm tab="events" tool={null} prompt={null} onCall={vi.fn()} onGet={vi.fn()} />
    );
    expect(
      screen.getByText('Server notifications stream into the Events list.')
    ).toBeInTheDocument();
  });

  it('keeps schema flattening at the invocation boundary', () => {
    expect(flattenMcpArgumentFields(tool.inputSchema)).toEqual([
      {
        name: 'attempts',
        type: 'integer',
        required: true,
        isComplex: false,
        description: 'Retry count',
      },
      { name: 'enabled', type: 'boolean', required: false, isComplex: false },
      { name: 'options', type: 'object', required: false, isComplex: true },
    ]);
  });

  it('uses canonical argument parsing before delegating an invocation', () => {
    const onCall = vi.fn();

    render(<McpInvokeForm tab="tools" tool={tool} prompt={null} onCall={onCall} onGet={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('integer'), {
      target: { value: '1.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Invoke' }));

    expect(onCall).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid integer.');
  });

  it('never reports arguments when seeding from saved values or the schema template', () => {
    const onToolArgumentsChange = vi.fn();
    const { rerender } = render(
      <McpInvokeForm
        tab="tools"
        tool={tool}
        prompt={null}
        onCall={vi.fn()}
        onGet={vi.fn()}
        toolArguments={{ attempts: 3, enabled: '', unknown: 'kept' }}
        onToolArgumentsChange={onToolArgumentsChange}
      />
    );
    expect(screen.getByPlaceholderText('integer')).toHaveValue('3');
    rerender(
      <McpInvokeForm
        tab="tools"
        tool={{ ...tool, name: 'other' }}
        prompt={null}
        onCall={vi.fn()}
        onGet={vi.fn()}
        onToolArgumentsChange={onToolArgumentsChange}
      />
    );
    expect(onToolArgumentsChange).not.toHaveBeenCalled();
  });

  it('persists every filled field on the first edit when there are no saved arguments', () => {
    const onToolArgumentsChange = vi.fn();
    render(
      <McpInvokeForm
        tab="tools"
        tool={tool}
        prompt={null}
        onCall={vi.fn()}
        onGet={vi.fn()}
        onToolArgumentsChange={onToolArgumentsChange}
      />
    );
    fireEvent.change(screen.getByPlaceholderText('integer'), { target: { value: '4' } });
    expect(onToolArgumentsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ attempts: 4 })
    );
  });

  describe('behaviour annotations (#880)', () => {
    const destructive: McpToolDescriptor = {
      name: 'drop_table',
      title: 'Drop table',
      annotations: { destructiveHint: true, idempotentHint: true },
    };

    it('shows the display title and hint badges', () => {
      render(
        <McpInvokeForm
          tab="tools"
          tool={destructive}
          prompt={null}
          onCall={vi.fn()}
          onGet={vi.fn()}
        />
      );
      expect(screen.getByText('Drop table')).toBeInTheDocument();
      expect(screen.getByText('DESTRUCTIVE')).toBeInTheDocument();
      expect(screen.getByText('IDEMPOTENT')).toBeInTheDocument();
    });

    it('asks for confirmation before invoking a destructive tool, and cancel does not call', async () => {
      const onCall = vi.fn().mockResolvedValue(undefined);
      render(
        <McpInvokeForm
          tab="tools"
          tool={destructive}
          prompt={null}
          onCall={onCall}
          onGet={vi.fn()}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Invoke' }));
      expect(onCall).not.toHaveBeenCalled();
      expect(await screen.findByText(/Invoke destructive tool "Drop table"\?/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onCall).not.toHaveBeenCalled();
    });

    it('invokes after the user confirms', async () => {
      const onCall = vi.fn().mockResolvedValue(undefined);
      render(
        <McpInvokeForm
          tab="tools"
          tool={destructive}
          prompt={null}
          onCall={onCall}
          onGet={vi.fn()}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Invoke' }));
      const dialog = await screen.findByRole('alertdialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Invoke' }));
      await waitFor(() =>
        expect(onCall).toHaveBeenCalledWith(destructive, {}, expect.any(AbortSignal))
      );
    });

    it('does not prompt for read-only or unannotated tools', async () => {
      const onCall = vi.fn().mockResolvedValue(undefined);
      render(
        <McpInvokeForm
          tab="tools"
          tool={{ name: 'peek', annotations: { readOnlyHint: true, destructiveHint: true } }}
          prompt={null}
          onCall={onCall}
          onGet={vi.fn()}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Invoke' }));
      await waitFor(() => expect(onCall).toHaveBeenCalled());
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.getByText('READ-ONLY')).toBeInTheDocument();
    });
  });

  it('shows Cancel only while a call is in flight and aborts the signal it passed', async () => {
    let signal: AbortSignal | undefined;
    let finish: () => void = () => undefined;
    const onCall = vi.fn(
      (_tool: unknown, _args: unknown, sig: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal = sig;
          finish = resolve;
        })
    );
    render(
      <McpInvokeForm
        tab="tools"
        tool={tool}
        prompt={null}
        onCall={onCall}
        onGet={vi.fn()}
        toolArguments={{ attempts: 1 }}
      />
    );
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Invoke' }));
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    expect(signal?.aborted).toBe(false);

    fireEvent.click(cancel);
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      finish();
    });
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});
