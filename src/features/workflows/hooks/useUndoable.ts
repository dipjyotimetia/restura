import { useCallback, useState } from 'react';

/** How a draft update enters history. */
export interface UndoableUpdate {
  /**
   * Updates sharing a key with the previous one replace it instead of adding a
   * step — a whole node drag, or typing one field, undoes as one action.
   */
  coalesce?: string;
  /** `false` updates the value without touching history (e.g. viewport pans). */
  history?: false;
}

export interface UndoableState<T> {
  past: T[];
  present: T;
  future: T[];
  lastKey: string | undefined;
}

export type UndoableAction<T> =
  | { type: 'set'; value: T; update?: UndoableUpdate }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; value: T };

export const UNDO_LIMIT = 50;

export function undoableReducer<T>(
  state: UndoableState<T>,
  action: UndoableAction<T>
): UndoableState<T> {
  switch (action.type) {
    case 'set': {
      if (action.update?.history === false) return { ...state, present: action.value };
      const key = action.update?.coalesce;
      if (key !== undefined && key === state.lastKey) {
        return { ...state, present: action.value, future: [] };
      }
      return {
        past: [...state.past, state.present].slice(-UNDO_LIMIT),
        present: action.value,
        future: [],
        lastKey: key,
      };
    }
    case 'undo': {
      const previous = state.past.at(-1);
      if (previous === undefined) return state;
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
        lastKey: undefined,
      };
    }
    case 'redo': {
      const [next, ...rest] = state.future;
      if (next === undefined) return state;
      return {
        past: [...state.past, state.present],
        present: next,
        future: rest,
        lastKey: undefined,
      };
    }
    case 'reset':
      return { past: [], present: action.value, future: [], lastKey: undefined };
  }
}

/** A value with bounded undo/redo history. `reset` replaces it and clears history. */
export function useUndoable<T>(initial: () => T) {
  const [state, setState] = useState<UndoableState<T>>(() => ({
    past: [],
    present: initial(),
    future: [],
    lastKey: undefined,
  }));
  const dispatch = useCallback(
    (action: UndoableAction<T>) => setState((s) => undoableReducer(s, action)),
    []
  );
  return {
    value: state.present,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    set: useCallback(
      (value: T, update?: UndoableUpdate) => dispatch({ type: 'set', value, update }),
      [dispatch]
    ),
    undo: useCallback(() => dispatch({ type: 'undo' }), [dispatch]),
    redo: useCallback(() => dispatch({ type: 'redo' }), [dispatch]),
    reset: useCallback((value: T) => dispatch({ type: 'reset', value }), [dispatch]),
  };
}

/** True when a keydown target is a text field / editor that owns Cmd+Z itself. */
export function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest('.monaco-editor')) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
