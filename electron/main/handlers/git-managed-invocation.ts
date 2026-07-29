import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { managedGitEnvironment } from './git-enterprise-policy';

export interface ManagedGitInvocation {
  env: NodeJS.ProcessEnv;
  configArgs: string[];
  cleanup(): Promise<void>;
}

/** Materialize managed Git network settings without placing secrets in argv or env. */
export async function prepareManagedGitInvocation(
  remoteUrl: string | undefined,
  isSshRemote: boolean
): Promise<ManagedGitInvocation> {
  const managed = await managedGitEnvironment(remoteUrl, isSshRemote);
  const baseConfigArgs = [
    '-c',
    'core.fsmonitor=',
    '-c',
    'core.sshCommand=',
    '-c',
    `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
  ];
  if (!managed.proxyUrl && !managed.caBundle && !managed.minimumTlsVersion) {
    return { env: managed.env, configArgs: baseConfigArgs, cleanup: async () => undefined };
  }

  const directory = await mkdtemp(path.join(tmpdir(), 'restura-git-'));
  try {
    const configPath = path.join(directory, 'managed-network.config');
    const lines = ['[http]', '\tsslVerify = true'];
    if (managed.proxyUrl) lines.push(`\tproxy = ${managed.proxyUrl}`);
    if (managed.proxyAuthMethod) lines.push(`\tproxyAuthMethod = ${managed.proxyAuthMethod}`);
    if (managed.minimumTlsVersion) {
      lines.push(`\tsslVersion = ${managed.minimumTlsVersion.toLowerCase()}`);
    }
    if (managed.caBundle) {
      const caPath = path.join(directory, 'managed-ca.pem');
      await writeFile(caPath, managed.caBundle, { mode: 0o600 });
      lines.push(`\tsslCAInfo = ${caPath}`);
    }
    await writeFile(configPath, `${lines.join('\n')}\n`, { mode: 0o600 });
    return {
      env: managed.env,
      configArgs: [...baseConfigArgs, '-c', `include.path=${configPath}`],
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
