import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { session } from 'electron';
import {
  applyManagedTransportPolicy,
  createEnterpriseProxyAgent,
  type ManagedTransportPolicy,
  resolveManagedProxyForUrl,
} from '../security/enterprise-network';
import {
  getManagedCaCertificateBundle,
  getManagedEnterprisePolicy,
} from '../security/managed-enterprise-policy';

/** Apply the managed HTTP route and trust policy to Schema Registry traffic. */
export async function managedSchemaRegistryAgent(url: string): Promise<HttpAgent | undefined> {
  const managed = getManagedEnterprisePolicy();
  if (managed.status.state === 'unmanaged') return undefined;
  const proxy = await resolveManagedProxyForUrl(url, session.defaultSession, managed);
  const transport: ManagedTransportPolicy = applyManagedTransportPolicy(
    { verifySsl: true, minTlsVersion: managed.policy!.network.minimumTlsVersion },
    managed,
    getManagedCaCertificateBundle()
  );
  if (proxy) return createEnterpriseProxyAgent(proxy, transport, managed);

  if (new URL(url).protocol === 'https:') {
    return new HttpsAgent({
      rejectUnauthorized: true,
      minVersion: transport.minTlsVersion,
      ...(transport.caCert?.pem ? { ca: transport.caCert.pem } : {}),
    });
  }
  return new HttpAgent();
}
