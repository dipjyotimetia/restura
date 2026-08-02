import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';

vi.mock('@/features/collections/lib/importers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/collections/lib/importers')>();
  return {
    ...actual,
    validateImportedCollection: vi.fn(() => ({
      ok: false,
      issues: ['collection fixture rejected'],
    })),
  };
});

import ImportDialog from '../ImportDialog';

describe('ImportDialog import validation', () => {
  beforeEach(() => {
    useCollectionStore.setState({ collections: [] });
  });

  it('rejects invalid converter output before showing a confirmation action', async () => {
    const user = userEvent.setup();
    render(<ImportDialog open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /paste the file contents/i }));
    fireEvent.change(screen.getByLabelText('Paste import content'), {
      target: {
        value: JSON.stringify({
          info: {
            name: 'Rejected collection',
            schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
          },
          item: [],
        }),
      },
    });

    await user.click(screen.getByRole('button', { name: /preview pasted postman/i }));
    expect(await screen.findByText(/collection fixture rejected/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confirm import/i })).not.toBeInTheDocument();
    expect(useCollectionStore.getState().collections).toHaveLength(0);
  });
});
