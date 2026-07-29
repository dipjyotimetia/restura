import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { KafkaAdvancedAdmin } from '../KafkaAdvancedAdmin';

const api = vi.hoisted(() => ({
  describeCluster: vi.fn(async () => ({
    success: true,
    cluster: { id: 'cluster-1', controllerId: 1, brokers: [], topics: [] },
  })),
  describeAcls: vi.fn(async () => ({ success: true, acls: [] })),
  createAcl: vi.fn(),
  deleteAcls: vi.fn(),
}));

vi.mock('@/lib/shared/platform', () => ({
  getElectronAPI: () => ({ kafka: api }),
}));

vi.mock('@/components/shared/CodeEditor', () => ({
  default: ({
    value,
    onChange,
    language,
    readOnly,
    ariaLabel,
  }: {
    value: string;
    onChange?: (value: string) => void;
    language?: string;
    readOnly?: boolean;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      data-editor="monaco"
      data-language={language}
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

describe('KafkaAdvancedAdmin', () => {
  it('keeps read-only inspection available and destructive actions confirmation-gated', async () => {
    const user = userEvent.setup();
    render(<KafkaAdvancedAdmin connectionId="connection-1" />);

    await user.click(screen.getByText('ACLs'));
    expect(await screen.findByLabelText('Typed ACL/filter JSON')).toHaveAttribute(
      'data-editor',
      'monaco'
    );
    expect(screen.getByRole('button', { name: 'Describe ACLs' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Create ACL' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete matching ACLs' })).toBeDisabled();

    await user.click(screen.getByText('Advanced topic operations'));
    expect(screen.getByRole('button', { name: 'Delete records before offset' })).toBeDisabled();
  });

  it('shows operation results near the top of the advanced admin surface', async () => {
    const user = userEvent.setup();
    render(<KafkaAdvancedAdmin connectionId="connection-1" />);

    await user.click(screen.getByText('Cluster metadata'));
    await user.click(screen.getByRole('button', { name: 'Describe cluster' }));

    const result = await screen.findByRole('status');
    expect(result).toHaveTextContent('Describe cluster result');
    expect(result).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByLabelText('Describe cluster result JSON')).toHaveAttribute(
      'data-editor',
      'monaco'
    );
    expect(screen.getByLabelText('Describe cluster result JSON')).toHaveAttribute('readonly');
  });

  it('reports malformed ACL JSON without escaping the operation boundary', async () => {
    const user = userEvent.setup();
    render(<KafkaAdvancedAdmin connectionId="connection-1" />);

    await user.click(screen.getByText('ACLs'));
    const acl = screen.getByLabelText('Typed ACL/filter JSON');
    fireEvent.change(acl, { target: { value: '{invalid' } });
    await user.click(screen.getByRole('button', { name: 'Describe ACLs' }));

    const result = await screen.findByRole('status');
    expect(result).toHaveTextContent('Describe ACLs result');
    expect(result).toHaveTextContent(/JSON|Unexpected/i);
  });
});
