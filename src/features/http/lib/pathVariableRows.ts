import { syncPathVariableRows } from '@shared/protocol/path-variables';
import type { HttpRequest, KeyValue } from '@/types';

/**
 * The `pathVariables` update that keeps a request's rows in step with `url`
 * (new `:name` → empty row, removed name → row dropped, remaining names keep
 * value/description/enabled). Empty when nothing changes, so a URL edit on a
 * request with no path variables writes no field.
 */
export function pathVariablesPatch(
  url: string,
  current: readonly KeyValue[] | undefined,
  makeId: () => string
): Partial<Pick<HttpRequest, 'pathVariables'>> {
  const next = syncPathVariableRows(url, current, makeId);
  if (next === current || (current === undefined && next.length === 0)) return {};
  return { pathVariables: next };
}
