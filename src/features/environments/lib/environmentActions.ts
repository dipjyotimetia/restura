import type { Environment } from '@/types';

export function duplicateEnvironment(source: Environment, createId: () => string): Environment {
  return {
    ...source,
    id: createId(),
    name: `${source.name} (copy)`,
    variables: source.variables.map((variable) => ({ ...variable, id: createId() })),
  };
}
