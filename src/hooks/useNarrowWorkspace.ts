import { useMediaQuery } from './useMediaQuery';

/** Below this width the request/response split is forced to stacked. */
export const NARROW_WORKSPACE_QUERY = '(max-width: 1279px)';

/** Why the side-by-side layout setting is currently overridden. */
export const NARROW_LAYOUT_REASON = 'Window too narrow for side-by-side';

/**
 * True while the window is too narrow for a side-by-side request/response
 * layout — the workspace then renders stacked regardless of the persisted
 * `layoutOrientation`, so controls that write it should say so.
 */
export function useNarrowWorkspace(): boolean {
  return useMediaQuery(NARROW_WORKSPACE_QUERY);
}
