import {
  configureManagedDesktopSessions,
  type EnterpriseSessionProxy,
} from '../security/enterprise-network';
import {
  getManagedCaCertificateBundle,
  getManagedEnterprisePolicy,
  type ManagedPolicyLoadResult,
} from '../security/managed-enterprise-policy';
import { applyManagedUpdaterPolicy, type ManagedUpdaterTarget } from './auto-updater';

export interface ManagedConnectivityTargets {
  applicationSession: EnterpriseSessionProxy;
  updaterSession: EnterpriseSessionProxy;
  updater: ManagedUpdaterTarget;
}

/**
 * Apply the selected machine policy to every native desktop network boundary.
 * Kept as one orchestration seam so startup and integration tests exercise the
 * same application and updater configuration sequence.
 */
export async function applyManagedDesktopConnectivity(
  targets: ManagedConnectivityTargets,
  options: {
    policy?: ManagedPolicyLoadResult;
    env?: NodeJS.ProcessEnv;
    readCaFile?: (filePath: string) => string;
  } = {}
): Promise<{ managed: boolean; updatesEnabled: boolean }> {
  const policy = options.policy ?? getManagedEnterprisePolicy();
  getManagedCaCertificateBundle(options.readCaFile);
  await configureManagedDesktopSessions(
    {
      application: targets.applicationSession,
      updater: targets.updaterSession,
    },
    policy
  );
  const updater = applyManagedUpdaterPolicy(targets.updater, policy, options.env);
  return { managed: updater.managed, updatesEnabled: updater.enabled };
}
