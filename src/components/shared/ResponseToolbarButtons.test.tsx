import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSettingsStore } from '@/store/useSettingsStore';
import { IconButton, LayoutToggleButton } from './ResponseToolbarButtons';

const media = vi.hoisted(() => ({ narrow: false }));
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => media.narrow }));

const renderWithTooltips = (ui: React.ReactElement) =>
  render(<TooltipProvider>{ui}</TooltipProvider>);

describe('LayoutToggleButton', () => {
  beforeEach(() => {
    media.narrow = false;
    useSettingsStore.getState().updateSettings({ layoutOrientation: 'horizontal' });
  });

  it('toggles between side-by-side and stacked', () => {
    renderWithTooltips(<LayoutToggleButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to stacked layout' }));
    expect(useSettingsStore.getState().settings.layoutOrientation).toBe('vertical');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to side-by-side layout' }));
    expect(useSettingsStore.getState().settings.layoutOrientation).toBe('horizontal');
  });

  it('explains instead of toggling when the window is too narrow', () => {
    media.narrow = true;
    renderWithTooltips(<LayoutToggleButton />);
    const button = screen.getByRole('button', { name: /needs a window at least 1280px wide/ });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button);
    expect(useSettingsStore.getState().settings.layoutOrientation).toBe('horizontal');
  });
});

describe('IconButton', () => {
  it('marks the active state', () => {
    renderWithTooltips(<IconButton icon={<span />} label="Search" active onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Search' }).className).toContain('text-sp-accent');
  });
});
