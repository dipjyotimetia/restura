import { isPrivateAddress } from '@shared/protocol/url-validation';
import type { KafkaRegistry } from '../store/useKafkaStore';

/**
 * Renderer hint mirroring the main-process rule: registry credentials only
 * cross plain HTTP to loopback / private-network registries. Literal hosts
 * can be judged here; hostnames are resolved (and enforced) at connect.
 */
export function registryTransportWarning(registry: KafkaRegistry): string | null {
  let url: URL;
  try {
    url = new URL(registry.url);
  } catch {
    return null;
  }
  const hasCredentials = registry.authType === 'bearer' || Boolean(registry.auth?.username?.trim());
  if (url.protocol !== 'http:' || !hasCredentials) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || isPrivateAddress(host)) return null;
  return /^[\d.]+$/.test(host) || host.includes(':')
    ? 'Credentials are not sent over plain HTTP to a public address — use an https:// registry URL.'
    : `Plain HTTP: credentials are only sent if ${host} resolves to a loopback or private-network address — otherwise connecting fails; use https:// for public registries.`;
}
