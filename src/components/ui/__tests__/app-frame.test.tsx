import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppFrame, MAIN_CONTENT_ID } from '../app-frame';

describe('AppFrame (A9 banner slot, A15 skip link)', () => {
  it('lays banners out inside one viewport-height column so they take space instead of pushing the app below the fold', () => {
    const { container } = render(
      <AppFrame banners={<div data-testid="banner">Update ready</div>}>
        <div data-testid="app">app</div>
      </AppFrame>
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(/\bh-dvh\b/);
    expect(root.className).toMatch(/\boverflow-hidden\b/);
    expect(root.className).toMatch(/\bflex-col\b/);

    const slot = screen.getByTestId('banner').parentElement as HTMLElement;
    const content = screen.getByTestId('app').parentElement as HTMLElement;
    expect(slot.className).toMatch(/\bshrink-0\b/);
    expect(content.className).toMatch(/\bflex-1\b/);
    expect(content.className).toMatch(/\bmin-h-0\b/);
    // Banner slot precedes the app in DOM (and layout) order.
    expect(slot.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('starts with a skip link that moves focus to the main content without touching the hash route', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/';
    render(
      <AppFrame banners={null}>
        <main id={MAIN_CONTENT_ID} tabIndex={-1}>
          workspace
        </main>
      </AppFrame>
    );
    const skip = screen.getByRole('link', { name: /skip to main content/i });
    await user.tab();
    expect(skip).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('main')).toHaveFocus();
    expect(window.location.hash).toBe('#/');
  });
});
