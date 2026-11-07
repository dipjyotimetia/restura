import type { Environment } from '@/types';

export function duplicateEnvironment(source: Environment, createId: () => string): Environment {
  return {
    ...source,
    id: createId(),
    name: `${source.name} (copy)`,
    variables: source.variables.map((variable) => ({ ...variable, id: createId() })),
  };
}

/**
 * Why `id` can't be deleted yet (the store refuses while it owns
 * sub-environments), or `null` when it can.
 */
export function subEnvironmentDeleteRefusal(
  environments: readonly Environment[],
  id: string
): string | null {
  const subCount = environments.filter((environment) => environment.parentId === id).length;
  if (subCount === 0) return null;
  const name = environments.find((environment) => environment.id === id)?.name ?? 'environment';
  return `Can't delete "${name}". Remove its ${subCount} sub-environment${subCount === 1 ? '' : 's'} first.`;
}
