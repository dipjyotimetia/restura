import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { JudgeAnchor } from '../../types';
import { JudgeAnchorsEditor } from '../JudgeAnchorsEditor';

describe('JudgeAnchorsEditor (#1039)', () => {
  it('adds an anchor with a mid-scale default score', () => {
    const onChange = vi.fn();
    render(<JudgeAnchorsEditor anchors={undefined} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /add anchor/i }));
    expect(onChange).toHaveBeenCalledWith([{ output: '', score: 0.5 }]);
  });

  it('edits output, score and note of an existing anchor', () => {
    const onChange = vi.fn();
    const anchors: JudgeAnchor[] = [{ output: 'meh', score: 0.4 }];
    render(<JudgeAnchorsEditor anchors={anchors} onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText('example output'), {
      target: { value: 'great' },
    });
    expect(onChange).toHaveBeenLastCalledWith([{ output: 'great', score: 0.4 }]);
    fireEvent.change(screen.getByLabelText('Anchor 1 score'), { target: { value: '0.9' } });
    expect(onChange).toHaveBeenLastCalledWith([{ output: 'meh', score: 0.9 }]);
    fireEvent.change(screen.getByPlaceholderText('why this score (optional)'), {
      target: { value: 'solid' },
    });
    expect(onChange).toHaveBeenLastCalledWith([{ output: 'meh', score: 0.4, note: 'solid' }]);
  });

  it('clamps scores to 0-1 and drops the field when the last anchor is removed', () => {
    const onChange = vi.fn();
    render(<JudgeAnchorsEditor anchors={[{ output: 'x', score: 0.4 }]} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Anchor 1 score'), { target: { value: '7' } });
    expect(onChange).toHaveBeenLastCalledWith([{ output: 'x', score: 1 }]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove anchor 1' }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});
