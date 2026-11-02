/**
 * The renderer's script host: what a pre-request / test script can reach from the
 * app. One definition for every Protocol (HTTP, gRPC, MCP), so `rs.sendRequest`,
 * `rs.cookies`, `rs.vault`, the optional `rs.judge` and the app's globals behave
 * the same wherever a script runs.
 */
import type { ScriptPhaseHost } from '@shared/scripts/script-phase';
import { makeRendererJudge } from '@/lib/shared/judgeBridge';
import { makeVaultAdapter } from '@/lib/shared/vaultClient';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { makeCookieAdapter } from './pmCookieAdapter.renderer';
import { makeRendererSendRequest } from './pmSendRequestHost';

export interface RendererScriptHostOptions {
  /** The variable map `{{var}}` in a sub-request resolves against. */
  variables: Record<string, string>;
  /** Default headers inherited by `rs.sendRequest` sub-requests; a call's own headers win. */
  inheritedHeaders: Record<string, string>;
  /** The parent send's abort signal: cancelling it cancels in-flight sub-requests. */
  signal?: AbortSignal | undefined;
  /**
   * Wire `rs.judge` (only where a response exists to judge). It is bound only
   * when the user has enabled and configured a judge provider; otherwise
   * `rs.judge` rejects with a clean "not wired in" error.
   */
  judge?: boolean | undefined;
}

export function makeRendererScriptHost(options: RendererScriptHostOptions): ScriptPhaseHost {
  const judgeConfig = options.judge ? useSettingsStore.getState().settings.judge : undefined;
  return {
    bridges: {
      sendRequest: makeRendererSendRequest({
        variables: options.variables,
        inheritedHeaders: options.inheritedHeaders,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
      cookies: (currentUrl) => makeCookieAdapter(currentUrl),
      vault: makeVaultAdapter(),
      ...(judgeConfig?.enabled ? { judge: makeRendererJudge(judgeConfig) } : {}),
    },
    globals: () => useGlobalsStore.getState().vars,
    applyGlobalsMutations: (mutations) => useGlobalsStore.getState().applyMutations(mutations),
  };
}
