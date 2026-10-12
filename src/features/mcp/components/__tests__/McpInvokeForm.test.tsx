import { fireEvent, render, screen } from '@testing-library/react';
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
});
