import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { HttpRequest, RequestSettings } from '@/types';
import CodeGeneratorDialog from '../CodeGeneratorDialog';

const originalSettings = useSettingsStore.getState().settings;

afterEach(() => {
  useSettingsStore.setState({ settings: originalSettings });
});

describe('CodeGeneratorDialog', () => {
  it('inherits global settings omitted by a partial request override', () => {
    useSettingsStore.setState({
      settings: {
        ...originalSettings,
        followRedirects: true,
        maxRedirects: 7,
        verifySsl: false,
      },
    });
    const request: HttpRequest = {
      id: 'request-id',
      name: 'Inherited codegen settings',
      type: 'http',
      method: 'GET',
      url: 'https://api.example.com',
      headers: [],
      params: [],
      body: { type: 'none' },
      auth: { type: 'none' },
      settings: { timeout: 2_000 } as RequestSettings,
    };

    render(<CodeGeneratorDialog open onOpenChange={() => undefined} request={request} />);

    expect(screen.getByText(/--max-time 2/)).toBeInTheDocument();
    expect(screen.getByText(/--max-redirs 7/)).toBeInTheDocument();
    expect(screen.getByText(/--insecure/)).toBeInTheDocument();
  });
});
