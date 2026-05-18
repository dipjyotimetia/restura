/**
 * Method → Badge variant lookup. Shared by every node renderer and the
 * sidebar that displays a method chip next to a request name. Falls
 * back to `'mono'` for non-HTTP methods (e.g. SSE, GRPC, MCP).
 */
import type { badgeVariants } from '@/components/ui/badge';
import type { VariantProps } from 'class-variance-authority';

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

const METHOD_BADGE: Record<string, BadgeVariant> = {
  GET: 'get',
  POST: 'post',
  PUT: 'put',
  DELETE: 'delete',
  PATCH: 'patch',
  OPTIONS: 'options',
  HEAD: 'head',
};

export function methodBadgeVariant(method: string): BadgeVariant {
  return METHOD_BADGE[method.toUpperCase()] ?? 'mono';
}
