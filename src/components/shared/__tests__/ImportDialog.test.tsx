import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import ImportDialog from '../ImportDialog';

describe('ImportDialog', () => {
  beforeEach(() => {
    useCollectionStore.setState({ collections: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires explicit confirmation before a pasted collection mutates the store', async () => {
    const user = userEvent.setup();
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /paste the file contents/i }));
    fireEvent.change(screen.getByLabelText('Paste import content'), {
      target: {
        value: JSON.stringify({
          info: {
            name: 'Preview API',
            schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
          },
          item: [],
        }),
      },
    });
    await user.click(screen.getByRole('button', { name: /preview pasted postman/i }));

    expect(await screen.findByRole('region', { name: 'Import preview' })).toBeInTheDocument();
    expect(useCollectionStore.getState().collections).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /confirm import/i }));
    expect(useCollectionStore.getState().collections).toHaveLength(1);
  });

  it('uses the same-origin bounded endpoint for a remote URL and stages its detected result', async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          text: JSON.stringify({
            openapi: '3.0.0',
            info: { title: 'Remote API', version: '1.0.0' },
            paths: {},
          }),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetcher);
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Remote URL/ }));
    fireEvent.change(screen.getByLabelText('HTTPS URL'), {
      target: { value: 'https://example.com/openapi.json' },
    });
    await user.click(screen.getByRole('button', { name: /fetch preview/i }));

    expect(fetcher).toHaveBeenCalledWith(
      '/api/import/fetch',
      expect.objectContaining({ method: 'POST' })
    );
    expect(await screen.findByText('Detected format: OpenAPI')).toBeInTheDocument();
    expect(useCollectionStore.getState().collections).toHaveLength(0);
  });
});
