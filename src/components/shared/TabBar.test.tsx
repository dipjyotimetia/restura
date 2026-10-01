import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRequestStore } from '@/store/useRequestStore';
import type { HttpRequest } from '@/types';
import { TabBar } from './TabBar';

const platform = vi.hoisted(() => ({ electron: true }));
const saveBack = vi.hoisted(() => ({ saveTabBackToCollection: vi.fn() }));

vi.mock('@/features/collections/lib/saveBack', () => saveBack);

vi.mock('@/lib/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/platform')>();
  return { ...actual, isElectron: () => platform.electron };
});

const makeHttp = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
  id: 'r-' + Math.random().toString(36).slice(2),
  name: 'Test',
  type: 'http',
  method: 'GET',
  url: 'https://example.com/',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
  ...overrides,
});

describe('TabBar', () => {
  beforeEach(() => {
    platform.electron = true;
    useRequestStore.setState({ tabs: [], activeTabId: null, isLoading: false });
  });

  it('renders the new-tab button when no tabs are open', () => {
    render(<TabBar />);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByRole('button', { name: /new request/i })).toBeInTheDocument();
  });

  it('describes the desktop Kafka surface as a client', async () => {
    const user = userEvent.setup();
    render(<TabBar />);

    await user.click(screen.getByRole('button', { name: /new request/i }));

    expect(screen.getByRole('menuitem', { name: /Kafka client/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Kafka consumer/i })).not.toBeInTheDocument();
  });

  it('shows Kafka and MQTT on web as disabled, desktop-only entries', async () => {
    platform.electron = false;
    const user = userEvent.setup();
    render(<TabBar />);

    await user.click(screen.getByRole('button', { name: /new request/i }));

    for (const name of [/Kafka client/i, /MQTT client/i]) {
      const item = screen.getByRole('menuitem', { name });
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item).toHaveTextContent('Desktop only');
    }
    expect(screen.getByRole('menuitem', { name: /HTTP request/i })).not.toHaveAttribute(
      'aria-disabled'
    );
  });

  it('renders one button per open tab with the request name', () => {
    useRequestStore.getState().openTab(makeHttp({ name: 'Get user' }));
    render(<TabBar />);
    expect(screen.getByRole('tab', { name: /Get user/ })).toBeInTheDocument();
  });

  it('marks the active tab with aria-selected', () => {
    const a = useRequestStore.getState().openTab(makeHttp({ name: 'A' }));
    useRequestStore.getState().openTab(makeHttp({ name: 'B' }));
    // The newly opened tab is now active; switch back to A
    useRequestStore.getState().switchTab(a);
    render(<TabBar />);
    const tabA = screen.getByRole('tab', { name: /A/ });
    const tabB = screen.getByRole('tab', { name: /B/ });
    expect(tabA).toHaveAttribute('aria-selected', 'true');
    expect(tabB).toHaveAttribute('aria-selected', 'false');
  });

  it('clicking a tab switches active', () => {
    const a = useRequestStore.getState().openTab(makeHttp({ name: 'A' }));
    useRequestStore.getState().openTab(makeHttp({ name: 'B' }));
    render(<TabBar />);
    fireEvent.click(screen.getByRole('tab', { name: /A/ }));
    expect(useRequestStore.getState().activeTabId).toBe(a);
  });

  it('clicking the close button on a tab closes it', () => {
    useRequestStore.getState().openTab(makeHttp({ name: 'A' }));
    render(<TabBar />);
    const closeBtn = screen.getByRole('button', { name: /close A/i });
    fireEvent.click(closeBtn);
    expect(useRequestStore.getState().tabs).toHaveLength(0);
  });

  it('shows a dirty indicator when isDirty is true', () => {
    useRequestStore.getState().openTab(makeHttp({ name: 'A' }));
    useRequestStore.getState().setDirty(true);
    render(<TabBar />);
    expect(screen.getByLabelText(/unsaved changes/i)).toBeInTheDocument();
  });

  it('does not show a dirty indicator when isDirty is false', () => {
    useRequestStore.getState().openTab(makeHttp({ name: 'A' }));
    render(<TabBar />);
    expect(screen.queryByLabelText(/unsaved changes/i)).not.toBeInTheDocument();
  });

  it('drag-reorders tabs via native DnD', () => {
    const a = useRequestStore.getState().openTab(makeHttp({ name: 'A' }));
    const b = useRequestStore.getState().openTab(makeHttp({ name: 'B' }));
    const c = useRequestStore.getState().openTab(makeHttp({ name: 'C' }));
    render(<TabBar />);

    const tabA = screen.getByRole('tab', { name: /A/ });
    const tabC = screen.getByRole('tab', { name: /C/ });

    // Drag A onto C → expected order: B, C-with-A-before-it (A inserted at C's position)
    fireEvent.dragStart(tabA);
    fireEvent.dragOver(tabC);
    fireEvent.drop(tabC);
    fireEvent.dragEnd(tabA);

    const order = useRequestStore.getState().tabs.map((t) => t.id);
    // A moved from position 0 to position 2 (where C was); result: [B, A, C] OR [B, C, A]
    // depending on how the drop is interpreted. The contract: A is now at the position
    // where C was, so the resulting order should be [B, C, A] (A inserted AFTER C is wrong;
    // standard convention: A inserted AT C's index, pushing C to the right) OR equivalently
    // [B, A, C]. Pick one and stick with it.
    expect(order).toEqual([b, c, a]);
  });

  describe('closing a tab with unsaved changes', () => {
    const openDirtyTab = (name: string, savedRequestId?: string) => {
      const id = useRequestStore.getState().openTab(makeHttp({ name }));
      useRequestStore.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === id ? { ...t, isDirty: true, ...(savedRequestId ? { savedRequestId } : {}) } : t
        ),
      }));
      return id;
    };

    beforeEach(() => saveBack.saveTabBackToCollection.mockReset());

    it('Save & close writes a saved-request tab back, then closes it', async () => {
      const user = userEvent.setup();
      saveBack.saveTabBackToCollection.mockReturnValue(true);
      openDirtyTab('Bound', 'saved-1');
      render(<TabBar />);

      await user.click(screen.getByRole('button', { name: /close Bound/i }));
      await user.click(screen.getByRole('button', { name: 'Save & close' }));

      expect(saveBack.saveTabBackToCollection).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Bound' }),
        'saved-1'
      );
      expect(useRequestStore.getState().tabs).toHaveLength(0);
    });

    it('keeps the tab open when writing back fails', async () => {
      const user = userEvent.setup();
      saveBack.saveTabBackToCollection.mockReturnValue(false);
      openDirtyTab('Bound', 'saved-1');
      render(<TabBar />);

      await user.click(screen.getByRole('button', { name: /close Bound/i }));
      await user.click(screen.getByRole('button', { name: 'Save & close' }));

      expect(useRequestStore.getState().tabs).toHaveLength(1);
      // The dialog stays open so the user can retry or pick another option.
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();

      saveBack.saveTabBackToCollection.mockReturnValue(true);
      await user.click(screen.getByRole('button', { name: 'Save & close' }));
      expect(useRequestStore.getState().tabs).toHaveLength(0);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('Save… on an unsaved tab hands off to the save dialog and leaves the tab open', async () => {
      const user = userEvent.setup();
      const onSaveToCollection = vi.fn();
      const id = openDirtyTab('Fresh');
      render(<TabBar onSaveToCollection={onSaveToCollection} />);

      await user.click(screen.getByRole('button', { name: /close Fresh/i }));
      await user.click(screen.getByRole('button', { name: 'Save…' }));

      expect(onSaveToCollection).toHaveBeenCalledWith(id);
      expect(saveBack.saveTabBackToCollection).not.toHaveBeenCalled();
      expect(useRequestStore.getState().tabs).toHaveLength(1);
    });

    it('closes a clean tab immediately, without asking', async () => {
      const user = userEvent.setup();
      useRequestStore.getState().openTab(makeHttp({ name: 'Clean' }));
      render(<TabBar />);

      await user.click(screen.getByRole('button', { name: /close Clean/i }));

      expect(useRequestStore.getState().tabs).toHaveLength(0);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('asks first and keeps the tab when the user backs out', async () => {
      const user = userEvent.setup();
      openDirtyTab('Edited');
      render(<TabBar />);

      await user.click(screen.getByRole('button', { name: /close Edited/i }));

      expect(screen.getByRole('alertdialog')).toHaveTextContent(/unsaved changes/i);
      expect(useRequestStore.getState().tabs).toHaveLength(1);

      await user.click(screen.getByRole('button', { name: 'Keep open' }));
      expect(useRequestStore.getState().tabs).toHaveLength(1);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    it('discards the tab only after the user confirms', async () => {
      const user = userEvent.setup();
      openDirtyTab('Edited');
      render(<TabBar />);

      await user.click(screen.getByRole('button', { name: /close Edited/i }));
      await user.click(screen.getByRole('button', { name: 'Discard' }));

      expect(useRequestStore.getState().tabs).toHaveLength(0);
    });

    it('also guards the Delete-key shortcut', async () => {
      const user = userEvent.setup();
      openDirtyTab('Edited');
      render(<TabBar />);

      screen.getByRole('tab', { name: /Edited/ }).focus();
      await user.keyboard('{Delete}');

      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      expect(useRequestStore.getState().tabs).toHaveLength(1);
    });

    it('Close Others asks before discarding unsaved edits in other tabs', async () => {
      const user = userEvent.setup();
      useRequestStore.getState().openTab(makeHttp({ name: 'Keep' }));
      openDirtyTab('Edited');
      render(<TabBar />);

      fireEvent.contextMenu(screen.getByRole('tab', { name: /Keep/ }));
      await user.click(await screen.findByRole('menuitem', { name: 'Close Others' }));

      const dialog = screen.getByRole('alertdialog');
      expect(dialog).toHaveTextContent('Edited');
      expect(useRequestStore.getState().tabs).toHaveLength(2);

      await user.click(screen.getByRole('button', { name: 'Keep open' }));
      expect(useRequestStore.getState().tabs).toHaveLength(2);

      fireEvent.contextMenu(screen.getByRole('tab', { name: /Keep/ }));
      await user.click(await screen.findByRole('menuitem', { name: 'Close Others' }));
      await user.click(screen.getByRole('button', { name: 'Discard & close' }));
      expect(useRequestStore.getState().tabs.map((t) => t.request.name)).toEqual(['Keep']);
    });

    it('Close All closes clean tabs immediately, without asking', async () => {
      const user = userEvent.setup();
      useRequestStore.getState().openTab(makeHttp({ name: 'A' }));
      useRequestStore.getState().openTab(makeHttp({ name: 'B' }));
      render(<TabBar />);

      fireEvent.contextMenu(screen.getByRole('tab', { name: /^A/ }));
      await user.click(await screen.findByRole('menuitem', { name: 'Close All' }));

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(useRequestStore.getState().tabs).toHaveLength(0);
    });
  });
});
