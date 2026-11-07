import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GeneralSection } from '../GeneralSection';

function setNarrow(narrow: boolean) {
  vi.mocked(window.matchMedia).mockImplementation(
    (query: string) =>
      ({
        matches: narrow && query.includes('max-width: 1279px'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList
  );
}

describe('GeneralSection layout orientation (A6)', () => {
  beforeEach(() => setNarrow(false));

  it('notes when the window is too narrow for the side-by-side setting to apply', () => {
    setNarrow(true);
    render(<GeneralSection />);
    expect(screen.getByText(/window too narrow for side-by-side/i)).toBeInTheDocument();
  });

  it('shows no override note on wide windows', () => {
    render(<GeneralSection />);
    expect(screen.queryByText(/window too narrow/i)).toBeNull();
  });
});
