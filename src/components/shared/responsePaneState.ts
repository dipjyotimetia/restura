/**
 * Closed UI state for the response pane — loading / empty / ready are mutually
 * exclusive. Keeps the ResponseViewer branch from encoding the same phase in
 * parallel `isLoading` + missing-response checks.
 */
export type ResponsePaneState<T> =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; response: T };

export function resolveResponsePaneState<T extends { partial?: boolean } | object>(
  isLoading: boolean,
  response: T | null | undefined
): ResponsePaneState<T> {
  const partial =
    response !== null &&
    response !== undefined &&
    'partial' in response &&
    Boolean((response as { partial?: boolean }).partial);
  if (isLoading && !partial) return { status: 'loading' };
  if (!response) return { status: 'empty' };
  return { status: 'ready', response };
}
