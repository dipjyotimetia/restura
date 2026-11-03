import type { RequestSettings, RequestSettingsOverride } from '@/types';

/**
 * Optional request settings an editor can clear back to "use the default"
 * (no CA / client cert override, Auto HTTP version, runtime TLS floor).
 */
type ClearableSettingKey = 'caCert' | 'clientCert' | 'httpVersion' | 'minTlsVersion';

/**
 * A change to a request's settings override. Keys absent from the patch are
 * left alone; a clearable key given as `undefined` is removed.
 */
export type RequestSettingsPatch = Omit<Partial<RequestSettings>, ClearableSettingKey> & {
  [K in ClearableSettingKey]?: RequestSettings[K] | undefined;
};

function setOrClear<K extends ClearableSettingKey>(
  settings: RequestSettingsOverride,
  key: K,
  value: RequestSettings[K] | undefined
): void {
  if (value === undefined) delete settings[key];
  else settings[key] = value;
}

/** `current` with `patch` applied; never mutates `current`. */
export function applySettingsPatch<T extends RequestSettingsOverride>(
  current: T,
  patch: RequestSettingsPatch
): T {
  const { caCert, clientCert, httpVersion, minTlsVersion, ...rest } = patch;
  const next: T = { ...current, ...rest };
  if ('caCert' in patch) setOrClear(next, 'caCert', caCert);
  if ('clientCert' in patch) setOrClear(next, 'clientCert', clientCert);
  if ('httpVersion' in patch) setOrClear(next, 'httpVersion', httpVersion);
  if ('minTlsVersion' in patch) setOrClear(next, 'minTlsVersion', minTlsVersion);
  return next;
}
