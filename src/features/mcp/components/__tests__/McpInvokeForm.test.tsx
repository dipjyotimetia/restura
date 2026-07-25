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
});
