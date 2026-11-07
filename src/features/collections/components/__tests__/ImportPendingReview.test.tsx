import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ImportResult, ImportWarning } from '@/features/collections/lib/importers';
import { ImportPendingReview } from '../ImportPendingReview';

const outcome = {
  collection: {
    id: 'c',
    name: 'Shop',
    items: [{ id: 'r', name: 'r', type: 'request', request: { type: 'http' } }],
  },
} as unknown as ImportResult;

function renderReview(over: Partial<Parameters<typeof ImportPendingReview>[0]> = {}) {
  const props = {
    outcome,
    formatName: undefined,
    warnings: [] as ImportWarning[],
    existingNames: [] as string[],
    clashChoice: 'keep-both' as const,
    onClashChoiceChange: vi.fn(),
    confirming: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
  render(<ImportPendingReview {...props} />);
  return props;
}

const warning = (requestName: string): ImportWarning => ({
  kind: 'unrecognized-body',
  requestName,
});

describe('ImportPendingReview', () => {
  it('summarises a single-request collection without a format or warnings', () => {
    renderReview();
    expect(screen.getByText(/1 request$/)).toBeInTheDocument();
    expect(screen.queryByText(/Detected format/)).not.toBeInTheDocument();
    expect(screen.queryByText(/will be retained/)).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('switches the name-clash choice to replace', async () => {
    const props = renderReview({ existingNames: ['Shop'] });
    const [keepBoth, replace] = screen.getAllByRole('radio');
    expect(keepBoth).toBeChecked();
    expect(replace).not.toBeChecked();
    await userEvent.click(replace as HTMLElement);
    expect(props.onClashChoiceChange).toHaveBeenCalledWith('replace');
  });

  it('shows the clash choice as replace when selected and keeps both on request', async () => {
    const props = renderReview({ existingNames: ['Shop'], clashChoice: 'replace' });
    const [keepBoth, replace] = screen.getAllByRole('radio');
    expect(replace).toBeChecked();
    await userEvent.click(keepBoth as HTMLElement);
    expect(props.onClashChoiceChange).toHaveBeenCalledWith('keep-both');
  });

  it('uses the singular for one warning', () => {
    renderReview({ warnings: [warning('a')] });
    expect(screen.getByText(/1 warning will be retained/)).toBeInTheDocument();
  });

  it('keeps duplicate warnings as separate rows and caps the preview', () => {
    const warnings = [
      warning('dup'),
      warning('dup'),
      warning('b'),
      warning('c'),
      warning('d'),
      warning('e'),
      warning('f'),
    ];
    renderReview({ warnings });
    expect(screen.getByText(/7 warnings will be retained/)).toBeInTheDocument();
    expect(screen.getAllByText(/Unknown body shape in "dup"/)).toHaveLength(2);
    expect(screen.queryByText(/"e"/)).not.toBeInTheDocument();
    expect(screen.getByText(/and 2 more, listed after import/)).toBeInTheDocument();
  });

  it('shows environment-only imports without dropped-secret notice when none dropped', () => {
    renderReview({
      outcome: { kind: 'environment-only', environment: { name: 'Prod' }, droppedSecretKeys: [] },
    });
    expect(screen.getByText('Prod')).toBeInTheDocument();
    expect(screen.queryByText(/Secret values are not imported/)).not.toBeInTheDocument();
  });

  it('disables Confirm while confirming and still allows Cancel', async () => {
    const props = renderReview({ confirming: true });
    expect(screen.getByRole('button', { name: 'Confirm import' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onCancel).toHaveBeenCalledOnce();
  });
});
