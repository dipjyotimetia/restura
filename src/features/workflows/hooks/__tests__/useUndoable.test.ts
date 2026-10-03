import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  isTextEditingTarget,
  UNDO_LIMIT,
  type UndoableState,
  undoableReducer,
  useUndoable,
} from '../useUndoable';

const start = (present: number): UndoableState<number> => ({
  past: [],
  present,
  future: [],
  lastKey: undefined,
});

describe('undoableReducer', () => {
  it('records each plain set and walks undo / redo', () => {
    let s = start(0);
    s = undoableReducer(s, { type: 'set', value: 1 });
    s = undoableReducer(s, { type: 'set', value: 2 });
    expect(s.past).toEqual([0, 1]);

    s = undoableReducer(s, { type: 'undo' });
    expect(s.present).toBe(1);
    s = undoableReducer(s, { type: 'redo' });
    expect(s.present).toBe(2);

    // A new edit after undo drops the redo branch.
    s = undoableReducer(undoableReducer(s, { type: 'undo' }), { type: 'set', value: 9 });
    expect(s.future).toEqual([]);
    expect(s.present).toBe(9);
  });

  it('coalesces consecutive updates with the same key into one step', () => {
    let s = start(0);
    for (const v of [1, 2, 3]) {
      s = undoableReducer(s, { type: 'set', value: v, update: { coalesce: 'move:a' } });
    }
    expect(s.past).toEqual([0]);
    expect(s.present).toBe(3);

    // A different key starts a new step; undo returns to the coalesced value.
    s = undoableReducer(s, { type: 'set', value: 4, update: { coalesce: 'move:b' } });
    expect(undoableReducer(s, { type: 'undo' }).present).toBe(3);
    // After an undo, the same key does not merge into the restored value.
    const afterUndo = undoableReducer(s, { type: 'undo' });
    expect(
      undoableReducer(afterUndo, { type: 'set', value: 7, update: { coalesce: 'move:b' } }).past
    ).toEqual([0, 3]);
  });

  it('applies history:false updates without creating steps', () => {
    let s = undoableReducer(start(0), { type: 'set', value: 1 });
    s = undoableReducer(s, { type: 'set', value: 2, update: { history: false } });
    expect(s.past).toEqual([0]);
    expect(s.present).toBe(2);
  });

  it('ignores undo/redo at the ends, caps history, and resets', () => {
    expect(undoableReducer(start(0), { type: 'undo' })).toEqual(start(0));
    expect(undoableReducer(start(0), { type: 'redo' })).toEqual(start(0));

    let s = start(0);
    for (let i = 1; i <= UNDO_LIMIT + 5; i++) s = undoableReducer(s, { type: 'set', value: i });
    expect(s.past).toHaveLength(UNDO_LIMIT);

    expect(undoableReducer(s, { type: 'reset', value: 42 })).toEqual(start(42));
  });
});

describe('useUndoable', () => {
  it('exposes value, flags, and actions', () => {
    const { result } = renderHook(() => useUndoable(() => 'a'));
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.set('b'));
    expect(result.current.value).toBe('b');
    expect(result.current.canUndo).toBe(true);
    act(() => result.current.undo());
    expect(result.current.value).toBe('a');
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.redo());
    expect(result.current.value).toBe('b');
    act(() => result.current.reset('z'));
    expect(result.current.canUndo).toBe(false);
    expect(result.current.value).toBe('z');
  });
});

describe('isTextEditingTarget', () => {
  it('recognises inputs, textareas, selects, contenteditable and Monaco', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    const monaco = document.createElement('div');
    monaco.className = 'monaco-editor';
    const inMonaco = document.createElement('span');
    monaco.appendChild(inMonaco);
    const button = document.createElement('button');

    for (const el of [input, textarea, select, editable, inMonaco]) {
      expect(isTextEditingTarget(el)).toBe(true);
    }
    expect(isTextEditingTarget(button)).toBe(false);
    expect(isTextEditingTarget(null)).toBe(false);
  });
});
