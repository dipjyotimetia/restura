import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ electron: false }));
vi.mock('@/lib/shared/platform', async (orig) => ({
  ...(await orig<typeof import('@/lib/shared/platform')>()),
  isElectron: () => platform.electron,
}));

import { GrpcReflectionErrorBanner } from '../GrpcReflectionErrorBanner';

afterEach(() => {
  platform.electron = false;
});

describe('GrpcReflectionErrorBanner', () => {
  it('falls back to a generic reason and adds the web hint', () => {
    render(<GrpcReflectionErrorBanner error={undefined} />);
    const text = screen.getByText(/Reflection failed/).textContent ?? '';
    expect(text).toContain('Could not reach the gRPC server.');
    expect(text).toContain('needs the Restura desktop app');
    expect(text).not.toContain('Settings → Certificates');
  });

  it.each([
    'unable to verify the first certificate',
    'self signed certificate in chain',
    'TLS handshake failed',
  ])('suggests adding a CA for a TLS error (%s)', (error) => {
    platform.electron = true;
    render(<GrpcReflectionErrorBanner error={error} />);
    const text = screen.getByText(/Reflection failed/).textContent ?? '';
    expect(text).toContain(error);
    expect(text).toContain('add its CA in Settings → Certificates');
    // Desktop already speaks native gRPC: no web hint.
    expect(text).not.toContain('desktop app');
  });

  it('shows only the reason for a non-TLS error on desktop', () => {
    platform.electron = true;
    render(<GrpcReflectionErrorBanner error="UNIMPLEMENTED: reflection disabled" />);
    expect(screen.getByText(/Reflection failed/).textContent).toBe(
      'Reflection failed: UNIMPLEMENTED: reflection disabled'
    );
  });
});
