import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { strToU8, zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import ImportDialog from '../ImportDialog';

/** #1200: Postman v3 folder / zip / single-file import through the dialog. */

const DEF = '$kind: collection\nname: Folder API\n';
const REQ = '$kind: http-request\nurl: https://api.example.com/users\nmethod: GET\n';

function folderFile(rel: string, text: string): File {
  return Object.assign(new File([text], rel.split('/').pop()!), { webkitRelativePath: rel });
}

/** jsdom's File lacks arrayBuffer() in some versions; give the zip a real one. */
function zipFile(name: string, files: Record<string, string>): File {
  const bytes = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
  const file = new File([bytes], name, { type: 'application/zip' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer });
  return file;
}

describe('ImportDialog — Postman v3', () => {
  beforeEach(() => {
    useCollectionStore.setState({ collections: [] });
    useEnvironmentStore.setState({ environments: [], activeEnvironmentId: null });
  });

  it('imports a picked v3 folder and shows the detected version', async () => {
    const user = userEvent.setup();
    render(<ImportDialog open onOpenChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /import folder/i })).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('postman-folder-input'), {
      target: {
        files: [
          folderFile('Folder API/.resources/definition.yaml', DEF),
          folderFile('Folder API/List.request.yaml', REQ),
        ],
      },
    });
    const preview = await screen.findByRole('region', { name: 'Import preview' });
    expect(preview).toHaveTextContent('Detected format: Postman v3');
    expect(preview).toHaveTextContent('Folder API');
    await user.click(screen.getByRole('button', { name: /confirm import/i }));
    expect(useCollectionStore.getState().collections[0]?.name).toBe('Folder API');
  });

  it('an empty folder pick is a no-op', () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByTestId('postman-folder-input'), { target: { files: [] } });
    expect(screen.queryByRole('region', { name: 'Import preview' })).not.toBeInTheDocument();
  });

  it('imports a v3 zip and refuses a traversal zip', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} />);
    fireEvent.change(document.querySelector('#file-upload-postman')!, {
      target: {
        files: [zipFile('c.zip', { 'Z/.resources/definition.yaml': DEF, 'Z/R.request.yaml': REQ })],
      },
    });
    expect(await screen.findByRole('region', { name: 'Import preview' })).toHaveTextContent(
      'Postman v3'
    );
    fireEvent.change(document.querySelector('#file-upload-postman')!, {
      target: { files: [zipFile('evil.zip', { '../evil.request.yaml': REQ })] },
    });
    expect(await screen.findByText(/escapes the collection folder/)).toBeInTheDocument();
  });

  it('routes a dropped v3 zip to Postman', async () => {
    render(
      <ImportDialog
        open
        onOpenChange={vi.fn()}
        droppedFile={zipFile('d.zip', { 'D/R.request.yaml': REQ })}
      />
    );
    expect(await screen.findByRole('region', { name: 'Import preview' })).toHaveTextContent(
      'Postman v3'
    );
  });
});
