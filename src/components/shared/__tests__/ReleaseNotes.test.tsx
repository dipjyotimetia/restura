import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReleaseNotes } from '../ReleaseNotes';

// The exact HTML shape electron-updater hands us from a GitHub release body.
const GITHUB_HTML = `<h2>0.3.4 — 2026-06-08</h2> <h3>Bug Fixes</h3> <ul> <li> <p>Wire TLS trust, reflection descriptors, and error surfacing for Electron (<a href="https://github.com/dipjyotimetia/restura/commit/a0fe6cf"><code>a0fe6cf</code></a>)</p> </li> </ul> <hr> <p>A CycloneDX SBOM is attached (<code>restura.cdx.json</code>).</p>`;

describe('ReleaseNotes', () => {
  it('renders GitHub HTML notes as real elements, not literal tags', () => {
    render(<ReleaseNotes html={GITHUB_HTML} />);

    // The bug: tags showed up as text. Real headings/lists must exist instead.
    expect(screen.getByRole('heading', { name: /Bug Fixes/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /0\.3\.4/ })).toBeInTheDocument();
    expect(screen.getByRole('listitem')).toBeInTheDocument();

    // Commit link survives sanitize and opens externally.
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://github.com/dipjyotimetia/restura/commit/a0fe6cf');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));

    // Inline <code> is preserved.
    expect(screen.getByText('a0fe6cf')).toBeInTheDocument();

    // No raw markup leaked through as text.
    expect(screen.queryByText(/<h3>|<ul>|<li>/)).not.toBeInTheDocument();
  });

  it('strips dangerous markup (sanitize is wired)', () => {
    render(
      <ReleaseNotes html={`<p>safe</p><img src=x onerror="alert(1)"><script>alert(2)</script>`} />
    );

    expect(screen.getByText('safe')).toBeInTheDocument();
    // The inline event handler must not survive sanitization.
    const img = document.querySelector('img');
    expect(img?.getAttribute('onerror')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });
});
