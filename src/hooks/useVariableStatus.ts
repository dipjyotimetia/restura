import { useCallback } from 'react';
import type { VariableStatus } from '@/components/ui/spatial';
import { HELPERS } from '@/lib/shared/dynamicVariables';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';

/**
 * Returns a classifier for `{{var}}` references used by the variable-highlight
 * overlays (URL bar, params/headers rows, the body variable summary).
 *
 * A name is 'resolved' if it's a `$dynamic` helper that exists, or an enabled
 * variable in the active environment. Everything else is 'unresolved' so the
 * overlay can flag it as a warning before the request fires — matching the
 * Environment Manager's promise that missing variables surface inline.
 */
export function useVariableStatus(): (name: string) => VariableStatus {
  const activeEnv = useEnvironmentStore((s) => s.getActiveEnvironment());
  return useCallback(
    (name: string): VariableStatus => {
      if (name.startsWith('$')) {
        return name.slice(1) in HELPERS ? 'resolved' : 'unresolved';
      }
      const known = activeEnv?.variables.some((v) => v.enabled && v.key === name) ?? false;
      return known ? 'resolved' : 'unresolved';
    },
    [activeEnv]
  );
}
