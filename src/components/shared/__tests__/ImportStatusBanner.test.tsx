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

  it('describes each supported warning, caps the list, and falls back safely for unknown data', () => {
    const warnings = [
      { kind: 'unrecognized-body', requestName: 'Body shape' },
      { kind: 'unrecognized-script-type', scriptType: 'pre-request', requestName: 'Script' },
      { kind: 'unsupported-auth', authType: 'Digest', requestName: 'Auth' },
      { kind: 'unsupported-method', method: 'PURGE', requestName: 'Method' },
      { kind: 'unknown-dynamic-var', varName: 'token', count: 2 },
      { kind: 'bruno-syntax', pattern: 'bru.getEnv', requestName: 'Bruno' },
      { kind: 'platform-unsupported', feature: 'Kafka', requestName: 'Kafka request' },
      { kind: 'schema-version', format: 'Postman', version: '3', note: 'newer export' },
      { kind: 'future-warning' },
      ...Array.from({ length: 12 }, (_, index) => ({
        kind: 'unsupported-method' as const,
        method: `CUSTOM-${index}`,
        requestName: `Request ${index}`,
      })),
    ];

    render(
      <ImportStatusBanner
        status="success"
        warnings={warnings as Parameters<typeof ImportStatusBanner>[0]['warnings']}
        environmentOnlyName={null}
        errorMessage=""
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByText('Imported with 21 warnings')).toBeInTheDocument();
    expect(screen.getByText(/Unknown body shape in "Body shape"/)).toBeInTheDocument();
    expect(screen.getByText(/Script type "pre-request" dropped/)).toBeInTheDocument();
    expect(screen.getByText(/Auth "Digest" not supported/)).toBeInTheDocument();
    expect(screen.getByText(/\{\{\$token\}\} referenced 2×/)).toBeInTheDocument();
    expect(screen.getByText(/Bruno-specific syntax "bru.getEnv"/)).toBeInTheDocument();
    expect(screen.getByText(/Kafka not available on this platform/)).toBeInTheDocument();
    expect(screen.getByText('Postman v3: newer export')).toBeInTheDocument();
    expect(screen.getByText('Unknown warning')).toBeInTheDocument();
    expect(screen.getByText('… and 1 more')).toBeInTheDocument();
  });

  it('shows generic success and import failure feedback', () => {
    const { rerender } = render(
      <ImportStatusBanner
        status="success"
        warnings={[]}
        environmentOnlyName={null}
        errorMessage=""
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByText('Collection imported successfully')).toBeInTheDocument();

    rerender(
      <ImportStatusBanner
        status="error"
        warnings={[]}
        environmentOnlyName={null}
        errorMessage="The file is invalid"
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByText('Import failed')).toBeInTheDocument();
    expect(screen.getByText('The file is invalid')).toBeInTheDocument();
  });
});
