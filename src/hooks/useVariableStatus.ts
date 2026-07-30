import { useCallback, useMemo } from 'react';
import type { VariableStatus } from '@/components/ui/spatial';
import { HELPERS } from '@/lib/shared/dynamicVariables';
import { parseScriptSetKeys } from '@/lib/shared/parseScriptSetKeys';
import { findAncestorFolderVariables } from '@/lib/shared/activeRequestScopes';
import { buildKnownNames } from '@/lib/shared/variableScopes';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { useRequestStore } from '@/store/useRequestStore';

/**
 * Returns a classifier for `{{var}}` references used by the variable-highlight
 * overlays (URL bar, params/headers rows, the body variable summary).
 *
 * A name is 'resolved' if it is a `$dynamic` helper that exists, or a name that
 * can resolve against any scope the send path actually merges: the active
 * environment, workspace globals, the collection this request belongs to (found
 * via the active tab's `savedRequestId`), or a key a pre-request script sets
 * statically (`pm.environment.set('x', ...)`). Everything else is 'unresolved' so
 * the overlay can flag a genuine typo before the request fires — matching the
 * scopes the resolvers substitute, so validation and execution never disagree.
 */
export function useVariableStatus(): (name: string) => VariableStatus {
  const environments = useEnvironmentStore((s) => s.environments);
  const activeEnvironmentId = useEnvironmentStore((s) => s.activeEnvironmentId);
  const globals = useGlobalsStore((s) => s.vars);
  const savedRequestId = useRequestStore((s) => s.getActiveTab()?.savedRequestId);
  const preRequestScript = useRequestStore((s) => s.getActiveTab()?.request.preRequestScript);
  const collection = useCollectionStore((s) =>
    savedRequestId ? s.getCollectionByItemId(savedRequestId) : undefined
  );

  const environmentChain = useMemo(() => {
    const active = environments.find((environment) => environment.id === activeEnvironmentId);
    if (!active) return [];
    if (!active.parentId) return [active];
    const parent = environments.find(
      (environment) =>
        environment.id === active.parentId && environment.collectionId === active.collectionId
    );
    return parent ? [parent, active] : [active];
  }, [activeEnvironmentId, environments]);

  const knownNames = useMemo(
    () =>
      buildKnownNames({
        baseEnvironment: environmentChain[0]?.variables,
        subEnvironment: environmentChain[1]?.variables,
        globals,
        collection: collection?.variables,
        folders:
          savedRequestId && collection
            ? findAncestorFolderVariables(collection.items, savedRequestId)
            : undefined,
        scriptSetKeys: parseScriptSetKeys(preRequestScript),
      }),
    [environmentChain, globals, collection, preRequestScript, savedRequestId]
  );

  return useCallback(
    (name: string): VariableStatus => {
      if (name.startsWith('$')) {
        return name.slice(1) in HELPERS ? 'resolved' : 'unresolved';
      }
      return knownNames.has(name) ? 'resolved' : 'unresolved';
    },
    [knownNames]
  );
}
