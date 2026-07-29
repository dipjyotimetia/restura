import { render, screen } from '@testing-library/react';
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

describe('KafkaAdvancedAdmin', () => {
  it('keeps read-only inspection available and destructive actions confirmation-gated', async () => {
    const user = userEvent.setup();
    render(<KafkaAdvancedAdmin connectionId="connection-1" />);

    await user.click(screen.getByText('ACLs'));
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

    expect(await screen.findByText(/"controllerId": 1/)).toBeVisible();
  });
});
