import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import ImportDialog from '../ImportDialog';

describe('ImportDialog', () => {
  beforeEach(() => {
    useCollectionStore.setState({ collections: [] });
    useEnvironmentStore.setState({ environments: [], activeEnvironmentId: null });
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

  it('stages an environment until confirmation and shows the environment-specific preview', async () => {
    const user = userEvent.setup();
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /paste the file contents/i }));
    fireEvent.change(screen.getByLabelText('Paste import content'), {
      target: {
        value: JSON.stringify({
          name: 'Preview Environment',
          _postman_variable_scope: 'environment',
          values: [{ key: 'baseUrl', value: 'https://api.example.com', enabled: true }],
        }),
      },
    });
    await user.click(screen.getByRole('button', { name: /preview pasted postman/i }));

    expect(await screen.findByText('Preview Environment')).toBeInTheDocument();
    expect(useEnvironmentStore.getState().environments).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: /confirm import/i }));
    expect(useEnvironmentStore.getState().environments).toHaveLength(1);
  });

  it('previews cURL content with retained warnings before committing it', async () => {
    const user = userEvent.setup();
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /^cURL/ }));
    await user.click(screen.getByRole('button', { name: /paste the file contents/i }));
    fireEvent.change(screen.getByLabelText('Paste import content'), {
      target: {
        value: 'curl https://api.example.com --compressed --cert ./client.pem',
      },
    });
    await user.click(screen.getByRole('button', { name: /preview pasted curl/i }));

    expect(await screen.findByText('Detected format: cURL')).toBeInTheDocument();
    expect(screen.getByText(/2 warnings will be retained/i)).toBeInTheDocument();
    expect(useCollectionStore.getState().collections).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: /confirm import/i }));
    expect(useCollectionStore.getState().collections).toHaveLength(1);
  });

  it('reads .http and cURL files into previews before persistence', async () => {
    const user = userEvent.setup();
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /^\.http File/ }));
    fireEvent.change(document.querySelector('#file-upload-http')!, {
      target: {
        files: [
          {
            name: 'example.http',
            text: async () => 'GET https://api.example.com/health',
          },
        ],
      },
    });
    expect(await screen.findByText('Detected format: .http File')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: /^cURL/ }));
    fireEvent.change(document.querySelector('#file-upload-curl')!, {
      target: {
        files: [
          {
            name: 'example.sh',
            text: async () => 'curl https://api.example.com/health --compressed',
          },
        ],
      },
    });
    expect(await screen.findByText('Detected format: cURL')).toBeInTheDocument();
    expect(screen.getByText(/1 warning will be retained/i)).toBeInTheDocument();
  });

  it('keeps HAR captures in a selection review until the chosen requests are confirmed', async () => {
    const user = userEvent.setup();
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /^HAR/ }));
    fireEvent.change(document.querySelector('#file-upload-har')!, {
      target: {
        files: [
          {
            name: 'capture.har',
            text: async () =>
              JSON.stringify({
                log: {
                  version: '1.2',
                  entries: [
                    {
                      startedDateTime: '2026-08-02T00:00:00.000Z',
                      time: 1,
                      request: {
                        method: 'POST',
                        url: 'https://api.example.com/users',
                        httpVersion: 'HTTP/1.1',
                        headers: [],
                        queryString: [],
                        cookies: [],
                        headersSize: -1,
                        bodySize: 0,
                      },
                      response: {
                        status: 201,
                        statusText: 'Created',
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
              }),
          },
        ],
      },
    });

    expect(await screen.findByRole('region', { name: 'HAR review' })).toBeInTheDocument();
    expect(useCollectionStore.getState().collections).toHaveLength(0);

    const entry = screen.getByRole('checkbox', { name: /select/i });
    await user.click(entry);
    await user.click(entry);
    await user.click(screen.getByRole('button', { name: /select none/i }));
    expect(screen.getByRole('button', { name: /import selected requests/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /select all/i }));
    await user.click(screen.getByRole('button', { name: /import selected requests/i }));
    expect(useCollectionStore.getState().collections).toHaveLength(1);
  });

  it('parses OpenAPI YAML and Bruno files through their source-specific upload paths', async () => {
    const user = userEvent.setup();
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /^OpenAPI/ }));
    fireEvent.change(document.querySelector('#file-upload-openapi')!, {
      target: {
        files: [
          {
            name: 'spec.yml',
            text: async () =>
              'openapi: 3.0.0\ninfo:\n  title: YAML API\n  version: 1.0.0\npaths: {}',
          },
        ],
      },
    });
    expect(await screen.findByText('Detected format: OpenAPI')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: /^Bruno/ }));
    fireEvent.change(document.querySelector('#file-upload-bruno')!, {
      target: {
        files: [
          {
            name: 'health.bru',
            text: async () =>
              'meta {\n  name: Health\n  type: http\n}\n\nget {\n  url: https://api.example.com/health\n}',
          },
        ],
      },
    });
    expect(await screen.findByText('Detected format: Bruno')).toBeInTheDocument();
  });

  it('stages Hoppscotch environments separately from collections', async () => {
    const user = userEvent.setup();
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /^Hoppscotch/ }));
    await user.click(screen.getByRole('button', { name: /paste the file contents/i }));
    fireEvent.change(screen.getByLabelText('Paste import content'), {
      target: { value: JSON.stringify({ name: 'Hoppscotch Preview', variables: [] }) },
    });
    await user.click(screen.getByRole('button', { name: /preview pasted hoppscotch/i }));

    expect(await screen.findByText('Hoppscotch Preview')).toBeInTheDocument();
    expect(useCollectionStore.getState().collections).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: /confirm import/i }));
    expect(useEnvironmentStore.getState().environments).toHaveLength(1);
  });

  it('accepts a dropped import and reports malformed pasted content without mutating state', async () => {
    const user = userEvent.setup();
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    const input = document.querySelector('#file-upload-postman')!;
    const dropZone = input.parentElement!;
    fireEvent.dragOver(dropZone, { dataTransfer: { files: [] } });
    expect(screen.getByText(/Release to import Postman/i)).toBeInTheDocument();
    fireEvent.dragLeave(dropZone, { relatedTarget: null });

    fireEvent.drop(dropZone, { dataTransfer: { files: [] } });
    expect(useCollectionStore.getState().collections).toHaveLength(0);

    fireEvent.drop(dropZone, {
      dataTransfer: {
        files: [
          {
            name: 'dropped.json',
            text: async () =>
              JSON.stringify({
                info: {
                  name: 'Dropped API',
                  schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
                },
                item: [],
              }),
          },
        ],
      },
    });
    expect(await screen.findByText('Dropped API')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: /paste the file contents/i }));
    fireEvent.change(screen.getByLabelText('Paste import content'), {
      target: { value: '{not-json' },
    });
    await user.click(screen.getByRole('button', { name: /preview pasted postman/i }));
    expect(await screen.findByText(/unexpected token|end of the stream/i)).toBeInTheDocument();
    expect(useCollectionStore.getState().collections).toHaveLength(0);
  });

  it.each([
    [/^Bruno/, 'Paste .bru file contents…'],
    [/^\.http File/, 'Paste .http file contents…'],
    [/^cURL/, 'Paste one POSIX-shell cURL command…'],
  ])('uses the source-specific paste affordance', async (format, placeholder) => {
    const user = userEvent.setup();
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: format }));
    await user.click(screen.getByRole('button', { name: /paste the file contents/i }));
    expect(screen.getByLabelText('Paste import content')).toHaveAttribute(
      'placeholder',
      placeholder
    );
  });
});
