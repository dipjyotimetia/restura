import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  FrameAssertionBadge,
  FrameAssertionButton,
  FrameAssertionDetails,
} from '../FrameAssertionControls';

describe('FrameAssertionBadge', () => {
  it('renders nothing without a result', () => {
    const { container } = render(<FrameAssertionBadge result={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows pass, fail and error summaries', () => {
    const { rerender } = render(
      <FrameAssertionBadge
        result={{ status: 'passed', tests: [{ name: 'a', passed: true }], errors: [] }}
      />
    );
    expect(screen.getByTestId('frame-assertion-badge').textContent).toBe('✓ 1/1');
    rerender(
      <FrameAssertionBadge
        result={{
          status: 'failed',
          tests: [
            { name: 'a', passed: true },
            { name: 'b', passed: false },
          ],
          errors: [],
        }}
      />
    );
    expect(screen.getByTestId('frame-assertion-badge').textContent).toBe('✗ 1/2');
    rerender(<FrameAssertionBadge result={{ status: 'error', tests: [], errors: ['x'] }} />);
    expect(screen.getByTestId('frame-assertion-badge').textContent).toBe('! err');
  });
});

describe('FrameAssertionDetails', () => {
  it('lists tests and, for errors, the error messages', () => {
    const { rerender } = render(<FrameAssertionDetails result={undefined} />);
    expect(screen.queryByRole('list')).toBeNull();
    rerender(
      <FrameAssertionDetails
        result={{
          status: 'failed',
          tests: [{ name: 'has type', passed: false, error: 'expected 1 to equal 2' }],
          errors: ['dup'],
        }}
      />
    );
    expect(screen.getByText(/has type — expected 1 to equal 2/)).toBeInTheDocument();
    expect(screen.queryByText(/dup/)).toBeNull();
    rerender(
      <FrameAssertionDetails result={{ status: 'error', tests: [], errors: ['SyntaxError'] }} />
    );
    expect(screen.getByText(/SyntaxError/)).toBeInTheDocument();
  });
});

describe('FrameAssertionButton', () => {
  it('edits the script on blur and toggles enablement', () => {
    const onChange = vi.fn();
    render(<FrameAssertionButton config={undefined} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Frame assertions' }));
    const editor = screen.getByRole('textbox', { name: 'Frame assertion script' });
    fireEvent.change(editor, { target: { value: 'pm.test("t", () => {})' } });
    fireEvent.blur(editor);
    expect(onChange).toHaveBeenLastCalledWith({ enabled: false, script: 'pm.test("t", () => {})' });
    fireEvent.click(screen.getByRole('switch', { name: 'Enable frame assertions' }));
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true, script: 'pm.test("t", () => {})' });
  });

  it('does not emit a change when the script is unchanged', () => {
    const onChange = vi.fn();
    render(<FrameAssertionButton config={{ enabled: true, script: 'x' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Frame assertions' }));
    fireEvent.blur(screen.getByRole('textbox', { name: 'Frame assertion script' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
