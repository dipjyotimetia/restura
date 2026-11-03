import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { GrpcRequest } from '@/types';
import { AuthTypePicker } from './AuthTypePicker';

const groups = [
  {
    label: 'Common',
    options: [
      { value: 'none' as const, label: 'No Auth' },
      { value: 'bearer' as const, label: 'Bearer' },
    ],
  },
];

const request = { id: 'g-1', auth: { type: 'none' as const } };

afterEach(() => useCollectionStore.setState({ collections: [] }));

describe('AuthTypePicker', () => {
  it('marks the current type pressed and switches type, keeping other auth fields', () => {
    const onChange = vi.fn();
    const auth = { type: 'none' as const, bearer: { token: 'kept' } };
    render(
      <AuthTypePicker
        request={{ id: 'g', auth }}
        groups={groups}
        onChange={onChange}
        ariaLabel="Auth type"
      />
    );
    const group = screen.getByRole('group', { name: 'Auth type' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No Auth' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Bearer' }));
    expect(onChange).toHaveBeenCalledWith({ type: 'bearer', bearer: { token: 'kept' } });
  });

  it('labels "No Auth" as Inherit (…) when a folder supplies auth', () => {
    const grpc: GrpcRequest = {
      id: 'g-1',
      name: 'g',
      type: 'grpc',
      methodType: 'unary',
      url: '',
      service: '',
      method: '',
      metadata: [],
      message: '',
      auth: { type: 'none' },
    };
    useCollectionStore.setState({
      collections: [
        {
          id: 'c',
          name: 'C',
          items: [
            {
              id: 'f',
              name: 'F',
              type: 'folder',
              auth: { type: 'basic', basic: { username: 'u', password: 'p' } },
              items: [{ id: 'g-1', name: 'g', type: 'request', request: grpc }],
            },
          ],
        },
      ],
    } as never);
    render(
      <AuthTypePicker request={request} groups={groups} onChange={vi.fn()} ariaLabel="Auth type" />
    );
    expect(screen.getByRole('button', { name: 'Inherit (Basic)' })).toBeInTheDocument();
  });
});
