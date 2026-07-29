import {
  configureManagedDesktopSessions,
  type EnterpriseSessionProxy,
} from '../security/enterprise-network';
import {
  getManagedCaCertificateBundle,
  getManagedEnterprisePolicy,
  type ManagedPolicyLoadResult,
} from '../security/managed-enterprise-policy';
import {
  applyManagedUpdaterPolicy,
  configureManagedUpdaterRequestBoundary,
  type ManagedUpdaterTarget,
} from './auto-updater';

export interface ManagedConnectivityTargets {
  applicationSession: EnterpriseSessionProxy;
  updaterSession: EnterpriseSessionProxy;
  updater: ManagedUpdaterTarget;
}

interface BlockableSession {
  webRequest: {
    onBeforeRequest(
      filter: { urls: string[] },
      listener: (details: unknown, callback: (response: { cancel: boolean }) => void) => void
    ): void;
  };
}

/** Deny renderer/updater session egress after managed policy fails to apply. */
export function blockManagedSessionOutbound(electronSession: BlockableSession): void {
  electronSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true })
  );
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
  } = {}
): Promise<{ managed: boolean; updatesEnabled: boolean }> {
  const policy = options.policy ?? getManagedEnterprisePolicy();
  const managedCaBundle = getManagedCaCertificateBundle();
  await configureManagedDesktopSessions(
    {
      application: targets.applicationSession,
      updater: targets.updaterSession,
    },
    policy,
    managedCaBundle
  );
  const updater = applyManagedUpdaterPolicy(targets.updater, policy, options.env);
  if (updater.enabled && updater.managed) {
    configureManagedUpdaterRequestBoundary(targets.updaterSession, policy);
  }
  return { managed: updater.managed, updatesEnabled: updater.enabled };
}
