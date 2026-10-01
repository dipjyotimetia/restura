import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConsoleStore } from '@/store/useConsoleStore';
import ConsoleDrawer from './ConsoleDrawer';

// The expanded body is irrelevant here; keep the render light.
vi.mock('@/features/http/components/NetworkConsole', () => ({ default: () => null }));

describe('ConsoleDrawer shortcut', () => {
  beforeEach(() => {
    useConsoleStore.setState({ isExpanded: false });
  });

  it('Cmd/Ctrl+Shift+C opens the console while collapsed, and closes it again', async () => {
    render(<ConsoleDrawer />);
    await screen.findByRole('region', { name: 'Console' });

    act(() => {
      fireEvent.keyDown(window, { key: 'C', metaKey: true, shiftKey: true });
    });
    expect(useConsoleStore.getState().isExpanded).toBe(true);

    act(() => {
      fireEvent.keyDown(window, { key: 'C', ctrlKey: true, shiftKey: true });
    });
    expect(useConsoleStore.getState().isExpanded).toBe(false);
  });
});
