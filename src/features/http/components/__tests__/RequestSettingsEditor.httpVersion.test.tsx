import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GlobalSettings, RequestSettings } from '@/types';

const platform = { electron: false };
vi.mock('@/lib/shared/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/platform')>()),
  isElectron: () => platform.electron,
}));

import { CAPABILITIES } from '@/lib/shared/capabilities';
import RequestSettingsEditor from '../RequestSettingsEditor';

const settings = (over: Partial<RequestSettings> = {}): RequestSettings => ({
  timeout: 30000,
  followRedirects: true,
  maxRedirects: 10,
  verifySsl: true,
  ...over,
});

const globals = {
  defaultTimeout: 30000,
  followRedirects: true,
  maxRedirects: 10,
  verifySsl: true,
} as GlobalSettings;

function renderEditor(s: RequestSettings) {
  return render(
    <RequestSettingsEditor
      settings={s}
      globalSettings={globals}
      onSettingsChange={vi.fn()}
      onToggleOverride={vi.fn()}
      onProxyOverrideChange={vi.fn()}
    />
  );
}

describe('RequestSettingsEditor — HTTP version', () => {
  beforeEach(() => {
    platform.electron = false;
  });

  it('web: shows Auto only, disabled, with a desktop-only hint', () => {
    renderEditor(settings({ httpVersion: 'http1.1' }));
    const trigger = screen.getByRole('combobox', { name: /http version/i });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveTextContent(/auto/i);
    expect(screen.getByText(/runtime negotiates the protocol/i)).toBeInTheDocument();
  });

  it('desktop: enabled and reflects the stored preference', () => {
    platform.electron = true;
    renderEditor(settings({ httpVersion: 'h2c-prior-knowledge' }));
    const trigger = screen.getByRole('combobox', { name: /http version/i });
    expect(trigger).not.toBeDisabled();
    expect(trigger).toHaveTextContent(/prior knowledge/i);
  });

  it('desktop: defaults to Auto when unset', () => {
    platform.electron = true;
    renderEditor(settings());
    expect(screen.getByRole('combobox', { name: /http version/i })).toHaveTextContent(/auto/i);
  });

  it('gates on the http.version capability entry (ADR-0012), not on the platform alone', () => {
    const row = CAPABILITIES['http.version'];
    const original = row.web;
    row.web = true;
    try {
      renderEditor(settings({ httpVersion: 'http2' }));
      const trigger = screen.getByRole('combobox', { name: /http version/i });
      expect(trigger).not.toBeDisabled();
      expect(trigger).toHaveTextContent(/http\/2 only/i);
      const field = trigger.closest('.space-y-2') as HTMLElement;
      expect(within(field).queryByText(/desktop only/i)).not.toBeInTheDocument();
    } finally {
      row.web = original;
    }
  });
});
