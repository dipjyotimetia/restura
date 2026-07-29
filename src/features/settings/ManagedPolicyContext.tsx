import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import type { ElectronSecurityAPI } from '../../../electron/types/electron-api';

export type ManagedPolicyStatus = Awaited<
  ReturnType<ElectronSecurityAPI['getManagedPolicyStatus']>
>;

const ManagedPolicyContext = createContext<ManagedPolicyStatus>({ state: 'unmanaged' });

export function ManagedPolicyProvider({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<ManagedPolicyStatus>({ state: 'unmanaged' });

  useEffect(() => {
    if (!active || !isElectron()) return;
    let current = true;
    void getElectronAPI()
      ?.security.getManagedPolicyStatus()
      .then((next) => {
        if (current) setStatus(next);
      });
    return () => {
      current = false;
    };
  }, [active]);

  const value = useMemo(() => status, [status]);
  return <ManagedPolicyContext.Provider value={value}>{children}</ManagedPolicyContext.Provider>;
}

export function useManagedPolicyStatus(): ManagedPolicyStatus {
  return useContext(ManagedPolicyContext);
}

export function ManagedPolicyBanner() {
  const status = useManagedPolicyStatus();
  if (status.state === 'unmanaged') return null;
  const invalid = status.state === 'invalid';
  return (
    <div
      role={invalid ? 'alert' : 'status'}
      className={
        invalid
          ? 'mb-5 rounded-sp-btn border border-red-500/30 bg-red-500/10 p-3 text-sp-12 text-red-200'
          : 'mb-5 rounded-sp-btn border border-sp-accent/30 bg-sp-accent/10 p-3 text-sp-12 text-sp-text'
      }
    >
      <p className="font-semibold">
        {invalid
          ? 'Enterprise policy needs administrator attention'
          : 'Managed by your organization'}
      </p>
      <p className="mt-1 text-sp-muted">
        {invalid
          ? status.message
          : `${status.networkMode} network · ${status.updatesMode} updates${
              status.upgradeRequired ? ` · version ${status.minimumVersion} or newer required` : ''
            }`}
      </p>
    </div>
  );
}
