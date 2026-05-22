/**
 * Replaces the deleted `accessibility.test.tsx` (which covered IconRail +
 * legacy TabBar). Asserts ARIA wiring on the new Spatial Depth shell —
 * WindowChrome, TabStrip, UrlBar — plus the Floater primitive's neutrality.
 *
 * Manual ARIA assertions; no jest-axe dep introduced.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WindowChrome } from '../TopBar';
import { TabStrip } from '../TabBar';
import { UrlBar } from '@/features/http/components/UrlBar';
import { Floater } from '@/components/ui/spatial';
import { useRequestStore } from '@/store/useRequestStore';
import type { HttpMethod } from '@/types';

vi.mock('@/lib/shared/platform', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    isElectron: vi.fn(() => false),
    getPlatform: vi.fn(() => 'darwin'),
  };
});

beforeEach(() => {
  useRequestStore.setState((s) => ({ ...s, tabs: [], activeTabId: null }));
});

describe('a11y smoke — shell components', () => {
  describe('WindowChrome', () => {
    it('exposes role="banner" with an accessible name', () => {
      render(<WindowChrome />);
      expect(screen.getByRole('banner', { name: /application chrome/i })).toBeInTheDocument();
    });

    it('Search pill has an accessible name', () => {
      render(<WindowChrome />);
      expect(screen.getByRole('button', { name: /open command palette/i })).toBeInTheDocument();
    });

    it('Env pill announces the current environment via aria-label', () => {
      render(<WindowChrome />);
      const pill = screen.getByRole('button', { name: /switch environment/i });
      expect(pill.getAttribute('aria-label')).toMatch(/current: /i);
    });
  });

  describe('TabStrip', () => {
    it('exposes role="tablist" with a descriptive name', () => {
      useRequestStore.getState().createNewRequest('http');
      render(<TabStrip />);
      expect(screen.getByRole('tablist', { name: /request tabs/i })).toBeInTheDocument();
    });

    it('each tab uses role="tab" and aria-selected', () => {
      useRequestStore.getState().createNewRequest('http');
      useRequestStore.getState().createNewRequest('http');
      render(<TabStrip />);
      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(2);
      for (const tab of tabs) {
        expect(tab).toHaveAttribute('aria-selected');
      }
    });
  });

  describe('UrlBar', () => {
    function renderBar() {
      return render(
        <UrlBar
          method={'GET' as HttpMethod}
          url=""
          isLoading={false}
          onMethodChange={() => undefined}
          onUrlChange={() => undefined}
          onSend={() => undefined}
          onOpenCodeGen={() => undefined}
        />
      );
    }

    it('Send button has an accessible name', () => {
      renderBar();
      expect(screen.getByRole('button', { name: /send request/i })).toBeInTheDocument();
    });

    it('URL input announces "Request URL"', () => {
      renderBar();
      expect(screen.getByLabelText('Request URL')).toBeInTheDocument();
    });

    it('Method chip dropdown trigger announces the current method', () => {
      renderBar();
      expect(screen.getByRole('button', { name: /HTTP method: GET/i })).toBeInTheDocument();
    });
  });

  describe('Floater primitive', () => {
    it('renders as a plain div with no implicit role', () => {
      const { container } = render(<Floater>content</Floater>);
      const el = container.firstElementChild as HTMLElement;
      expect(el.tagName).toBe('DIV');
      // No role attribute means the a11y tree treats it as generic — exactly
      // what we want for a styling-only container.
      expect(el.hasAttribute('role')).toBe(false);
    });

    it('forwards arbitrary aria-* props', () => {
      const { container } = render(
        <Floater role="region" aria-label="Custom region">
          x
        </Floater>
      );
      const el = container.firstElementChild as HTMLElement;
      expect(el).toHaveAttribute('role', 'region');
      expect(el).toHaveAttribute('aria-label', 'Custom region');
    });
  });
});
