import type { RequestSettings, AppSettings } from '@/types';

/**
 * Project workspace (global) settings into the `RequestSettings` shape a request
 * inherits when it has no per-request override. This is the single source of
 * truth for *which* global fields fold into the effective settings; both the
 * request executor (`resolveEffectiveSettings`) and the per-request Settings
 * editor consume it, so the editor's displayed defaults can never drift from
 * what actually reaches the wire. Optional fields are folded only when set
 * (EOPT) so the redirect-policy emit logic's `!== undefined` checks stay honest.
 *
 * Kept in a standalone module (not in `requestExecutor.ts`) so the editor can
 * import it without pulling the executor's heavy transitive deps into the
 * renderer bundle.
 */
export function globalSettingsToRequestSettings(globalSettings: AppSettings): RequestSettings {
  return {
    timeout: globalSettings.defaultTimeout,
    followRedirects: globalSettings.followRedirects,
    maxRedirects: globalSettings.maxRedirects,
    verifySsl: globalSettings.verifySsl,
    proxy: globalSettings.proxy,
    ...(globalSettings.followOriginalMethod !== undefined && {
      followOriginalMethod: globalSettings.followOriginalMethod,
    }),
    ...(globalSettings.followAuthHeader !== undefined && {
      followAuthHeader: globalSettings.followAuthHeader,
    }),
    ...(globalSettings.stripReferer !== undefined && {
      stripReferer: globalSettings.stripReferer,
    }),
    ...(globalSettings.encodeUrlAutomatically !== undefined && {
      encodeUrlAutomatically: globalSettings.encodeUrlAutomatically,
    }),
    ...(globalSettings.disableCookieJar !== undefined && {
      disableCookieJar: globalSettings.disableCookieJar,
    }),
    ...(globalSettings.serverCipherOrder !== undefined && {
      serverCipherOrder: globalSettings.serverCipherOrder,
    }),
    ...(globalSettings.minTlsVersion !== undefined && {
      minTlsVersion: globalSettings.minTlsVersion,
    }),
    ...(globalSettings.cipherSuites !== undefined && {
      cipherSuites: globalSettings.cipherSuites,
    }),
  };
}

/**
 * Per-request settings with a global-settings fallback. Used by every transport
 * entry point (HTTP executor, the request page, GraphQL introspection) and the
 * per-request Settings editor so the fallback shape stays in one place.
 */
export function resolveEffectiveSettings(
  requestSettings: RequestSettings | undefined,
  globalSettings: AppSettings
): RequestSettings {
  return requestSettings ?? globalSettingsToRequestSettings(globalSettings);
}
