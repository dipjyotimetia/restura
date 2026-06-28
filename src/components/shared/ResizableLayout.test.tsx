import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ResizableLayout from './ResizableLayout';

const renderLayout = (props: Partial<React.ComponentProps<typeof ResizableLayout>> = {}) =>
  render(
    <ResizableLayout {...props}>
      <div>left</div>
      <div>right</div>
    </ResizableLayout>
  );

describe('ResizableLayout', () => {
  it('renders both children', () => {
    renderLayout();
    expect(screen.getByText('left')).toBeInTheDocument();
    expect(screen.getByText('right')).toBeInTheDocument();
  });

  it('defaults the separator to the 50% midpoint', () => {
    renderLayout();
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '50');
  });

  describe('uncontrolled keyboard resize', () => {
    it('steps the split by 5% on arrow keys', () => {
      renderLayout();
      const handle = screen.getByRole('separator');
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
      expect(handle).toHaveAttribute('aria-valuenow', '55');
      fireEvent.keyDown(handle, { key: 'ArrowLeft' });
      expect(handle).toHaveAttribute('aria-valuenow', '50');
    });

    it('clamps at the minimum (30%) when stepping down past it', () => {
      renderLayout();
      const handle = screen.getByRole('separator');
      for (let i = 0; i < 10; i++) fireEvent.keyDown(handle, { key: 'ArrowLeft' });
      expect(handle).toHaveAttribute('aria-valuenow', '30');
    });

    it('clamps at the maximum (70%) when stepping up past it', () => {
      renderLayout();
      const handle = screen.getByRole('separator');
      for (let i = 0; i < 10; i++) fireEvent.keyDown(handle, { key: 'ArrowRight' });
      expect(handle).toHaveAttribute('aria-valuenow', '70');
    });

    it('honours custom min/max bounds', () => {
      renderLayout({ minSplit: 20, maxSplit: 80, defaultSplit: 50 });
      const handle = screen.getByRole('separator');
      for (let i = 0; i < 20; i++) fireEvent.keyDown(handle, { key: 'ArrowRight' });
      expect(handle).toHaveAttribute('aria-valuenow', '80');
    });
  });

  describe('controlled mode', () => {
    it('renders the controlled split value', () => {
      renderLayout({ split: 40 });
      expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '40');
    });

    it('re-clamps an out-of-range controlled value on read', () => {
      const { rerender } = renderLayout({ split: 95 });
      expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '70');
      rerender(
        <ResizableLayout split={5}>
          <div>left</div>
          <div>right</div>
        </ResizableLayout>
      );
      expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '30');
    });

    it('emits clamped changes via onSplitChange and does not self-mutate', () => {
      const onSplitChange = vi.fn();
      renderLayout({ split: 50, onSplitChange });
      const handle = screen.getByRole('separator');
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
      expect(onSplitChange).toHaveBeenCalledWith(55);
      // Controlled: the parent owns the value, so the DOM stays put until the
      // prop changes.
      expect(handle).toHaveAttribute('aria-valuenow', '50');
    });

    it('clamps the emitted value at the max bound', () => {
      const onSplitChange = vi.fn();
      renderLayout({ split: 69, onSplitChange });
      fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' });
      // 69 + 5 = 74 → clamped to 70
      expect(onSplitChange).toHaveBeenCalledWith(70);
    });

    it('persists a drag once on release, not on every mousemove', () => {
      // Regression: routing each mousemove to the persisted store wrote to
      // IndexedDB 60–120× per drag. The gesture must commit a single time.
      const onSplitChange = vi.fn();
      renderLayout({ split: 50, onSplitChange });
      const handle = screen.getByRole('separator');
      fireEvent.mouseDown(handle);
      fireEvent.mouseMove(window, { clientX: 100, clientY: 100 });
      fireEvent.mouseMove(window, { clientX: 120, clientY: 120 });
      fireEvent.mouseMove(window, { clientX: 140, clientY: 140 });
      // Nothing persisted while dragging — the live preview stays local.
      expect(onSplitChange).not.toHaveBeenCalled();
      fireEvent.mouseUp(window);
      // Exactly one commit, on release.
      expect(onSplitChange).toHaveBeenCalledTimes(1);
    });
  });
});
