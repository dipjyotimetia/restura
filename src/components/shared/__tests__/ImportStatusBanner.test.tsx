import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ImportStatusBanner } from '../ImportStatusBanner';

describe('ImportStatusBanner', () => {
  it('renders nothing while an import is idle', () => {
    const { container } = render(
      <ImportStatusBanner
        status="idle"
        warnings={[]}
        environmentOnlyName={null}
        errorMessage=""
        onDismiss={vi.fn()}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('shows imported environment success feedback', () => {
    render(
      <ImportStatusBanner
        status="success"
        warnings={[]}
        environmentOnlyName="Staging"
        errorMessage=""
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByText('Imported environment: Staging')).toBeInTheDocument();
  });

  it('renders import warnings and delegates dismissal', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <ImportStatusBanner
        status="success"
        warnings={[{ kind: 'unsupported-method', method: 'PURGE', requestName: 'Clear cache' }]}
        environmentOnlyName={null}
        errorMessage=""
        onDismiss={onDismiss}
      />
    );

    expect(screen.getByText('Imported with 1 warning')).toBeInTheDocument();
    expect(
      screen.getByText('Method "PURGE" not supported — "Clear cache" imported as GET')
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
