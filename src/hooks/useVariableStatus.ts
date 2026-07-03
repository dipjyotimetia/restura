import { useCallback, useMemo } from 'react';
import type { VariableStatus } from '@/components/ui/spatial';
import { HELPERS } from '@/lib/shared/dynamicVariables';
import { parseScriptSetKeys } from '@/lib/shared/parseScriptSetKeys';
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
  const activeEnv = useEnvironmentStore((s) => s.getActiveEnvironment());
  const globals = useGlobalsStore((s) => s.vars);
  const savedRequestId = useRequestStore((s) => s.getActiveTab()?.savedRequestId);
  const preRequestScript = useRequestStore((s) => s.getActiveTab()?.request.preRequestScript);
  const collection = useCollectionStore((s) =>
    savedRequestId ? s.getCollectionByItemId(savedRequestId) : undefined
  );

  const knownNames = useMemo(
    () =>
      buildKnownNames({
        env: activeEnv?.variables,
        globals,
        collection: collection?.variables,
        scriptSetKeys: parseScriptSetKeys(preRequestScript),
      }),
    [activeEnv, globals, collection, preRequestScript]
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
