import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { summarizeWarnings } from '@/features/collections/lib/importers/types';
import ImportDialog from '../ImportDialog';
import { ImportStatusBanner } from '../ImportStatusBanner';
import { DIRECTORY_DROP_MESSAGE, folderPickWarnings, isDirectoryDrop } from '../import-dialog-data';

/** #1200 review round: security-downgrade rendering, folder pick guards, directory drops. */

describe('Postman v3 import review', () => {
  it('renders a security-downgrade warning in the status banner and summary', () => {
    const warning = {
      kind: 'security-downgrade' as const,
      setting: 'strictSSL',
      requestName: 'Login',
      detail: 'TLS certificate verification is off',
    };
    render(
      <ImportStatusBanner
        status="success"
        warnings={[warning]}
        environmentOnlyName={null}
        errorMessage=""
        onDismiss={vi.fn()}
      />
    );
    expect(
      screen.getByText(
        'Security downgrade in "Login": TLS certificate verification is off (strictSSL)'
      )
    ).toBeInTheDocument();
    expect(summarizeWarnings([warning])[0]?.sample).toContain('Security downgrade');
  });

  it('warns when a picked folder has requests but no .resources folders', () => {
    expect(folderPickWarnings({ 'C/r.request.yaml': 'x' })).toMatchObject([
      { construct: 'folder-resources', requestName: 'C' },
    ]);
    expect(
      folderPickWarnings({ 'C/r.request.yaml': 'x', 'C/.resources/definition.yaml': 'y' })
    ).toEqual([]);
  });

  it('detects a dropped directory and refuses it with a clear message', () => {
    const asDrop = (isDirectory: boolean) =>
      ({
        items: [{ webkitGetAsEntry: () => ({ isDirectory }) }],
        files: [new File([''], 'Folder')],
      }) as unknown as DataTransfer;
    expect(isDirectoryDrop(asDrop(true))).toBe(true);
    expect(isDirectoryDrop(asDrop(false))).toBe(false);
    expect(isDirectoryDrop({ items: [] } as unknown as DataTransfer)).toBe(false);

    render(<ImportDialog open onOpenChange={vi.fn()} />);
    // Drop events bubble from the hidden input to the drop zone's handler.
    const zone = document.querySelector('#file-upload-postman')!;
    fireEvent.drop(zone, { dataTransfer: asDrop(true) });
    expect(screen.getByText(DIRECTORY_DROP_MESSAGE)).toBeInTheDocument();
  });
});
