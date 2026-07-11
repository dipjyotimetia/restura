import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BugReportDialog } from '../BugReportDialog';
import type { BugReportDiagnostics } from '@/lib/shared/bug-report';

const diagnostics: BugReportDiagnostics = {
  appVersion: '1.4.0',
  platform: 'web',
  operatingSystem: 'macOS',
  browser: 'Chrome',
  route: '#/http',
  capturedAt: '2026-07-11T10:00:00.000Z',
  runtimeErrors: [],
};

describe('BugReportDialog', () => {
  it('requires a title and description before opening the GitHub draft', async () => {
    const user = userEvent.setup();
    const onOpenGitHubDraft = vi.fn();
    render(
      <BugReportDialog
        open
        onOpenChange={vi.fn()}
        diagnostics={diagnostics}
        onOpenGitHubDraft={onOpenGitHubDraft}
      />
    );

    await user.click(screen.getByRole('button', { name: /open github draft/i }));

    expect(screen.getByText(/title and description are required/i)).toBeInTheDocument();
    expect(onOpenGitHubDraft).not.toHaveBeenCalled();
  });

  it('passes only user-approved artifacts to the GitHub handoff', async () => {
    const user = userEvent.setup();
    const onOpenGitHubDraft = vi.fn();
    render(
      <BugReportDialog
        open
        onOpenChange={vi.fn()}
        diagnostics={diagnostics}
        screenshot={{ imageDataUrl: 'data:image/png;base64,c2NyZWVuc2hvdA==' }}
        onOpenGitHubDraft={onOpenGitHubDraft}
      />
    );

    await user.type(screen.getByLabelText(/^title/i), 'Response crash');
    await user.type(screen.getByLabelText(/^description/i), 'The response pane crashes.');
    await user.click(screen.getByLabelText(/include screenshot/i));
    await user.click(screen.getByLabelText(/include diagnostics/i));
    await user.click(screen.getByRole('button', { name: /open github draft/i }));

    expect(onOpenGitHubDraft).toHaveBeenCalledWith({
      title: 'Response crash',
      description: 'The response pane crashes.',
      steps: '',
      expected: '',
      actual: '',
      diagnostics: undefined,
      screenshot: undefined,
    });
  });

  it('clears its submitting state when reopened while a draft is still opening', async () => {
    const user = userEvent.setup();
    let resolveDraft: (() => void) | undefined;
    const onOpenGitHubDraft = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDraft = resolve;
        })
    );
    const props = {
      onOpenChange: vi.fn(),
      diagnostics,
      onOpenGitHubDraft,
    };
    const { rerender } = render(<BugReportDialog {...props} open />);

    await user.type(screen.getByLabelText(/^title/i), 'Response crash');
    await user.type(screen.getByLabelText(/^description/i), 'The response pane crashes.');
    await user.click(screen.getByRole('button', { name: /open github draft/i }));

    expect(screen.getByRole('button', { name: /open github draft/i })).toBeDisabled();

    rerender(<BugReportDialog {...props} open={false} />);
    rerender(<BugReportDialog {...props} open />);

    expect(screen.getByRole('button', { name: /open github draft/i })).toBeEnabled();
    resolveDraft?.();
  });

  it('shows a sanitized diagnostics preview before it is shared', () => {
    render(
      <BugReportDialog
        open
        onOpenChange={vi.fn()}
        diagnostics={{
          ...diagnostics,
          runtimeErrors: [{ message: 'Failed https://example.com/path?token=secret' }],
        }}
        onOpenGitHubDraft={vi.fn()}
      />
    );

    expect(screen.getByText(/diagnostic context/i)).toBeInTheDocument();
    expect(screen.queryByText(/token=secret/i)).not.toBeInTheDocument();
  });
});
