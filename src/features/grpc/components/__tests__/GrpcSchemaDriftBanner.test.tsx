/** #937 — the "schema changed since saved" notice in the gRPC builder. */
import type { GrpcSchemaChange } from '@shared/protocol/grpc-schema-drift';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UseGrpcSchemaDrift } from '@/features/grpc/hooks/useGrpcSchemaDrift';
import { GrpcSchemaDriftBanner } from '../GrpcSchemaDriftBanner';

const SNAPSHOT = { kind: 'proto', fileName: 's.proto', text: 'syntax = "proto3";' } as const;

function state(changes: GrpcSchemaChange[], fetchedAt?: number): UseGrpcSchemaDrift {
  const breaking = changes.filter((c) => c.severity === 'breaking').length;
  return {
    drift: {
      saved: fetchedAt === undefined ? SNAPSHOT : { ...SNAPSHOT, fetchedAt },
      next: SNAPSHOT,
      diff: { changes, breaking, nonBreaking: changes.length - breaking },
    },
    onServiceReflected: vi.fn(),
    saveUpload: vi.fn(),
    accept: vi.fn(),
    dismiss: vi.fn(),
  };
}

const added: GrpcSchemaChange = {
  rule: 'RPC_ADDED',
  severity: 'non-breaking',
  path: 'shop.v1.Shop.List',
  message: 'Method shop.v1.Shop.List was added',
};
const removed: GrpcSchemaChange = {
  rule: 'FIELD_NO_DELETE',
  severity: 'breaking',
  path: 'shop.v1.Item.qty',
  message: 'Field qty (#2) was removed',
};

describe('GrpcSchemaDriftBanner', () => {
  it('renders nothing without pending drift', () => {
    const { container } = render(<GrpcSchemaDriftBanner drift={{ ...state([]), drift: null }} />);
    expect(container.firstChild).toBeNull();
  });

  it('summarises additive-only drift without a saved timestamp', () => {
    render(<GrpcSchemaDriftBanner drift={state([added])} />);
    const banner = screen.getByRole('status', { name: 'gRPC schema drift' });
    expect(banner).toHaveTextContent('Schema changed since saved — 1 non-breaking');
    expect(banner).not.toHaveTextContent('(saved');
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByRole('listitem')).toHaveTextContent(
      'additiveRPC_ADDEDshop.v1.Shop.List — Method shop.v1.Shop.List was added'
    );
  });

  it('lists breaking changes, shows when the snapshot was saved, and wires the actions', () => {
    const drift = state([removed, added], Date.UTC(2026, 0, 2));
    render(<GrpcSchemaDriftBanner drift={drift} />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('1 breaking, 1 non-breaking');
    expect(banner).toHaveTextContent('(saved ');
    const details = screen.getByRole('button', { name: 'Details' });
    fireEvent.click(details);
    expect(details).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('breakingFIELD_NO_DELETE');
    fireEvent.click(details);
    expect(screen.queryByRole('listitem')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Keep saved' }));
    fireEvent.click(screen.getByRole('button', { name: 'Update snapshot' }));
    expect(drift.dismiss).toHaveBeenCalledOnce();
    expect(drift.accept).toHaveBeenCalledOnce();
  });
});
