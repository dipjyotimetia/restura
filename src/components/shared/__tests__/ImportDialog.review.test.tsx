import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import ImportDialog from '../ImportDialog';

const postman = JSON.stringify({
  info: {
    name: 'Preview API',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [
    {
      name: 'Users',
      item: [
        { name: 'List', request: { method: 'GET', url: 'https://api.test/users' } },
        { name: 'Create', request: { method: 'POST', url: 'https://api.test/users' } },
      ],
    },
  ],
});

async function stagePaste(user: ReturnType<typeof userEvent.setup>) {
  render(<ImportDialog open onOpenChange={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: /paste the file contents/i }));
  fireEvent.change(screen.getByLabelText('Paste import content'), { target: { value: postman } });
  await user.click(screen.getByRole('button', { name: /preview pasted postman/i }));
  return screen.findByRole('region', { name: 'Import preview' });
}

describe('ImportDialog review', () => {
  beforeEach(() => {
    useCollectionStore.setState({ collections: [] });
    useEnvironmentStore.setState({ environments: [], activeEnvironmentId: null });
  });

  it('counts requests and folders, and names the imported collection on success', async () => {
    const user = userEvent.setup();
    const preview = await stagePaste(user);
    expect(preview.textContent).toContain('2 requests in 1 folder');
    await user.click(screen.getByRole('button', { name: /confirm import/i }));
    expect(await screen.findByText('Imported "Preview API"')).toBeInTheDocument();
  });

  it('keeps both on a name clash by default, suffixing the new collection', async () => {
    useCollectionStore.setState({ collections: [{ id: 'old', name: 'Preview API', items: [] }] });
    const user = userEvent.setup();
    const preview = await stagePaste(user);
    expect(preview.textContent).toContain('A collection named "Preview API" already exists');
    expect(screen.getByRole('radio', { name: /keep both/i })).toBeChecked();
    await user.click(screen.getByRole('button', { name: /confirm import/i }));
    expect(useCollectionStore.getState().collections.map((c) => c.name)).toEqual([
      'Preview API',
      'Preview API 2',
    ]);
    expect(await screen.findByText('Imported "Preview API 2"')).toBeInTheDocument();
  });

  it('replaces the existing collection when chosen', async () => {
    useCollectionStore.setState({ collections: [{ id: 'old', name: 'Preview API', items: [] }] });
    const user = userEvent.setup();
    await stagePaste(user);
    await user.click(screen.getByRole('radio', { name: /replace/i }));
    await user.click(screen.getByRole('button', { name: /confirm import/i }));
    await screen.findByText('Imported "Preview API"');
    const collections = useCollectionStore.getState().collections;
    expect(collections).toHaveLength(1);
    expect(collections[0]?.id).not.toBe('old');
    expect(collections[0]?.name).toBe('Preview API');
  });

  it('keeps the existing collection when the replacement fails validation', async () => {
    useCollectionStore.setState({ collections: [{ id: 'old', name: 'Preview API', items: [] }] });
    // The store rejects the imported collection (schema failure).
    const original = useCollectionStore.getState().prepareCollection;
    const spy = vi.fn(() => {
      throw new Error('Invalid collection');
    });
    useCollectionStore.setState({ prepareCollection: spy });
    const user = userEvent.setup();
    await stagePaste(user);
    await user.click(screen.getByRole('radio', { name: /replace/i }));
    await user.click(screen.getByRole('button', { name: /confirm import/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const collections = useCollectionStore.getState().collections;
    expect(collections.map((c) => c.id)).toEqual(['old']);
    useCollectionStore.setState({ prepareCollection: original });
  });

  it("does not reuse a previous import's name for a later HAR import", async () => {
    const user = userEvent.setup();
    await stagePaste(user);
    await user.click(screen.getByRole('button', { name: /confirm import/i }));
    expect(await screen.findByText('Imported "Preview API"')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^HAR/ }));
    fireEvent.change(document.querySelector('#file-upload-har') as Element, {
      target: { files: [{ name: 'capture.har', text: async () => harCapture }] },
    });
    await screen.findByRole('region', { name: 'HAR review' });
    await user.click(screen.getByRole('button', { name: /import selected requests/i }));
    await waitFor(() => expect(useCollectionStore.getState().collections).toHaveLength(2));
    expect(screen.queryByText('Imported "Preview API"')).toBeNull();
    const harName = useCollectionStore.getState().collections[1]?.name ?? '';
    expect(screen.getByText(`Imported "${harName}"`)).toBeInTheDocument();
  });
});

const harCapture = JSON.stringify({
  log: {
    version: '1.2',
    entries: [
      {
        startedDateTime: '2026-08-02T00:00:00.000Z',
        time: 1,
        request: {
          method: 'GET',
          url: 'https://api.example.com/users',
          httpVersion: 'HTTP/1.1',
          headers: [],
          queryString: [],
          cookies: [],
          headersSize: -1,
          bodySize: 0,
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          headers: [],
          cookies: [],
          content: { size: 0, mimeType: 'application/json' },
          redirectURL: '',
          headersSize: -1,
          bodySize: 0,
        },
        cache: {},
        timings: { send: 0, wait: 1, receive: 0 },
      },
    ],
  },
});
