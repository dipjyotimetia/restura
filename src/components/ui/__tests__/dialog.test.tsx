import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../dialog';

describe('DialogContent (A15)', () => {
  it('caps its height to the viewport and scrolls overflowing content', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toMatch(/max-h-\[calc\(100dvh-2rem\)\]/);
    expect(dialog.className).toMatch(/\boverflow-y-auto\b/);
  });

  it('lets callers override overflow (e.g. dialogs with their own scroll region)', () => {
    render(
      <Dialog open>
        <DialogContent className="overflow-hidden">
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>
    );
    expect(screen.getByRole('dialog').className).not.toMatch(/\boverflow-y-auto\b/);
  });
});
