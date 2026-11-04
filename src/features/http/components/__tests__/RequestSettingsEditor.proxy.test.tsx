import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GlobalSettings, RequestSettings } from '@/types';

const platform = { electron: false };
vi.mock('@/lib/shared/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/platform')>()),
  isElectron: () => platform.electron,
}));

import { CAPABILITIES } from '@/lib/shared/capabilities';
import RequestSettingsEditor from '../RequestSettingsEditor';

const settings: RequestSettings = {
  timeout: 30000,
  followRedirects: true,
  maxRedirects: 10,
  verifySsl: true,
};

const globals = {
  defaultTimeout: 30000,
  followRedirects: true,
  maxRedirects: 10,
  verifySsl: true,
} as GlobalSettings;

function renderEditor() {
  return render(
    <RequestSettingsEditor
      settings={settings}
      globalSettings={globals}
      onSettingsChange={vi.fn()}
      onToggleOverride={vi.fn()}
      onProxyOverrideChange={vi.fn()}
    />
  );
}

describe('RequestSettingsEditor — per-request proxy', () => {
  beforeEach(() => {
    platform.electron = false;
  });

  it('is declared desktop-only in the capability matrix', () => {
    expect(CAPABILITIES['http.proxy.perRequest']).toMatchObject({ web: false, desktop: true });
  });

  it('web: flags "Custom Proxy for this Request" as desktop-only instead of silently dropping it', () => {
    renderEditor();
    const heading = screen.getByText('Custom Proxy for this Request');
    const badge = heading.parentElement?.querySelector('[aria-label="Desktop only feature"]');
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('title')).toBe(CAPABILITIES['http.proxy.perRequest'].notes);
  });

  it('desktop: shows no desktop-only badge on the proxy override', () => {
    platform.electron = true;
    renderEditor();
    const heading = screen.getByText('Custom Proxy for this Request');
    expect(heading.parentElement?.querySelector('[aria-label="Desktop only feature"]')).toBeNull();
  });
});
