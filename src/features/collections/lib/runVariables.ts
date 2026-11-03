/**
 * Variables for a collection run: globals < base environment < sub
 * environment < collection. Shared by the Runner dialog
 * (`useCollectionRun`) and the MCP control server's send tools, so both
 * resolve exactly the same values. Pure store reads, no React.
 */

import { buildValueMap, secretVariableNames } from '@/lib/shared/variableScopes';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import type { Collection, Environment } from '@/types';

/** Globals, enabled environment values, then collection values (highest precedence). */
export function buildBaseVars(
  globals: Record<string, string>,
  environment: Environment | readonly Environment[] | null,
  collection: Collection
): Record<string, string> {
  const chain = Array.isArray(environment) ? environment : environment ? [environment] : [];
  const [baseEnvironment, subEnvironment] = chain;
  return buildValueMap({
    globals,
    baseEnvironment: baseEnvironment?.variables,
    subEnvironment: subEnvironment?.variables,
    collection: collection.variables,
  });
}

export interface RunVariables {
  selectedEnvironment: Environment | null;
  /** Base environment first, then the selected sub-environment (when distinct). */
  environmentChain: Environment[];
  globalVars: Record<string, string>;
  baseVars: Record<string, string>;
  environmentVars: Record<string, string>;
  secretNames: string[];
}

/**
 * Variables for a run against `environmentId` ('none' or unknown ⇒ no
 * environment): globals < base env < sub env < collection. Shared by the
 * runner dialog and the MCP control server's send tools so both resolve
 * exactly the same values.
 */
export function resolveRunVariables(environmentId: string, collection: Collection): RunVariables {
  const allEnvironments = useEnvironmentStore.getState().environments;
  const selectedEnvironment = allEnvironments.find((e) => e.id === environmentId) ?? null;
  const baseEnvironment = selectedEnvironment?.parentId
    ? (allEnvironments.find((environment) => environment.id === selectedEnvironment.parentId) ??
      null)
    : selectedEnvironment;
  const environmentChain =
    baseEnvironment && selectedEnvironment && baseEnvironment.id !== selectedEnvironment.id
      ? [baseEnvironment, selectedEnvironment]
      : baseEnvironment
        ? [baseEnvironment]
        : [];
  const globalVars = useGlobalsStore.getState().vars;
  return {
    selectedEnvironment,
    environmentChain,
    globalVars,
    baseVars: buildBaseVars(globalVars, environmentChain, collection),
    environmentVars: buildValueMap({
      baseEnvironment: environmentChain[0]?.variables,
      subEnvironment: environmentChain[1]?.variables,
    }),
    secretNames: secretVariableNames(
      environmentChain[0]?.variables,
      environmentChain[1]?.variables
    ),
  };
}
