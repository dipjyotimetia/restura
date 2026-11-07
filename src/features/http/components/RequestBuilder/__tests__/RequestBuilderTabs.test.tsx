import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppSettings, HttpRequest } from '@/types';

vi.mock('@/features/http/components/RequestBodyEditor', () => ({
  default: () => <div data-testid="body-editor" />,
  bodyEditorFills: () => false,
}));
vi.mock('@/features/scripts/components/ScriptsEditor', () => ({ default: () => null }));
vi.mock('@/features/http/components/RequestSettingsEditor', () => ({ default: () => null }));
vi.mock('@/features/auth/components/AuthConfig', () => ({ default: () => null }));
vi.mock('@/features/auth/components/InheritedAuthHint', () => ({
  InheritedAuthHint: () => null,
  useInheritedAuth: () => null,
}));

import { RequestBuilderTabs } from '../RequestBuilderTabs';

const base: HttpRequest = {
  id: 'req',
  name: 'R',
  type: 'http',
  method: 'POST',
  url: 'https://example.test',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
};

const handlers = new Proxy({}, { get: () => vi.fn() }) as never;

function renderTabs(request: HttpRequest, activeTab: 'params' | 'body' = 'params') {
  return render(
    <RequestBuilderTabs
      request={request}
      activeTab={activeTab}
      onTabChange={vi.fn()}
      globalSettings={{} as AppSettings}
      counts={{ activeParams: 0, activeHeaders: 0 }}
      handlers={handlers}
    />
  );
}

describe('RequestBuilderTabs indicators (H7)', () => {
  it('shows no Scripts / Settings badge for a plain request', () => {
    renderTabs(base);
    expect(screen.getByRole('tab', { name: 'Scripts' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
  });

  it('badges Scripts when a pre-request or test script is set', () => {
    renderTabs({ ...base, preRequestScript: 'pm.x()', testScript: '  ' });
    expect(screen.getByRole('tab', { name: /Scripts/ })).toHaveTextContent('Pre');
  });

  it('badges Scripts with both phases', () => {
    renderTabs({ ...base, preRequestScript: 'a()', testScript: 'b()' });
    expect(screen.getByRole('tab', { name: /Scripts/ })).toHaveTextContent('Pre+Test');
  });

  it('badges Settings when the request overrides the global settings', () => {
    renderTabs({
      ...base,
      settings: { timeout: 1000, followRedirects: true, maxRedirects: 5, verifySsl: true },
    });
    expect(screen.getByRole('tab', { name: /Settings/ })).toHaveTextContent('Custom');
  });
});

describe('RequestBuilderTabs body Content-Type (H10)', () => {
  it('shows the default Content-Type for the body type', () => {
    renderTabs({ ...base, body: { type: 'json', raw: '{}' } }, 'body');
    const label = screen.getByTestId('body-content-type');
    expect(label).toHaveTextContent('application/json');
    expect(label).not.toHaveTextContent(/header/i);
  });

  it('shows a user-set Content-Type header as the effective value', () => {
    renderTabs(
      {
        ...base,
        body: { type: 'json', raw: '{}' },
        headers: [
          { id: 'h0', key: 'content-type', value: 'text/old', enabled: false },
          { id: 'h1', key: 'Content-Type', value: 'application/vnd.api+json', enabled: true },
        ],
      },
      'body'
    );
    const label = screen.getByTestId('body-content-type');
    expect(label).toHaveTextContent('application/vnd.api+json');
    expect(within(label).getByText(/from header/i)).toBeInTheDocument();
  });
});
