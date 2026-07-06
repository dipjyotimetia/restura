import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from '../useSettingsStore';

const auth = () => useSettingsStore.getState().settings.proxy.auth;
const updateProxyAuth = () => useSettingsStore.getState().updateProxyAuth;

describe('useSettingsStore — updateProxyAuth', () => {
  beforeEach(() => {
    // Reset the proxy to a clean state (no auth) between cases.
    useSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
      },
    }));
  });

  it('sets username + password', () => {
    updateProxyAuth()({ username: 'u', password: 'p' });
    expect(auth()).toEqual({ username: 'u', password: 'p' });
  });

  it('merges — updating the username preserves the existing password', () => {
    updateProxyAuth()({ username: 'u', password: 'p' });
    updateProxyAuth()({ username: 'u2' });
    expect(auth()).toEqual({ username: 'u2', password: 'p' });
  });

  it('omits the whole auth block once both fields resolve empty', () => {
    updateProxyAuth()({ username: 'u', password: 'p' });
    updateProxyAuth()({ username: '' });
    expect(auth()).toEqual({ username: '', password: 'p' }); // password still set → kept
    updateProxyAuth()({ password: '' });
    expect(auth()).toBeUndefined(); // both empty → dropped
  });

  it('keeps a handle password when only the username is blanked', () => {
    // A handle unwraps to a masked non-empty placeholder, so it counts as a
    // real secret — blanking the username alone does not drop it. The wire path
    // only applies proxy auth when a username is present, so an empty username
    // sends no credentials regardless; clearing the password removes the block.
    updateProxyAuth()({ username: 'u', password: { kind: 'handle', id: 'h1' } });
    updateProxyAuth()({ username: '' });
    expect(auth()).toEqual({ username: '', password: { kind: 'handle', id: 'h1' } });
  });
});
