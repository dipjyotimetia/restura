import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRequestStore } from '@/store/useRequestStore';
import type { HttpRequest, Response } from '@/types';

vi.mock('@/components/shared/CodeEditor', () => ({
  default: () => <div data-testid="code-editor" />,
}));

vi.mock('@/lib/shared/lazyComponent', () => ({
  lazyComponent: () => () => <div data-testid="lazy-component" />,
}));

vi.mock('@/features/ai/components/AiActionsMenu', () => ({
  AiActionsMenu: () => null,
}));

import ResponseViewer from '../ResponseViewer';

const htmlRequest: HttpRequest = {
  id: 'request-html',
  name: 'HTML response',
  type: 'http',
  method: 'GET',
  url: 'https://example.test',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
};

const htmlResponse: Response = {
  id: 'response-html',
  requestId: htmlRequest.id,
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'text/html' },
  body: `<main>
    <meta http-equiv="refresh" content="0;url=https://preview.invalid/navigation">
    <h1 style="color: green">Safe response content</h1>
    <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="local">
    <a href="https://preview.invalid/link">Unsafe link</a>
    <form action="https://preview.invalid/form"><button type="submit">Submit</button></form>
  </main>`,
  size: 410,
  time: 12,
  timestamp: 1,
};

describe('ResponseViewer HTML preview', () => {
  beforeEach(() => {
    useRequestStore.setState({
      tabs: [
        {
          id: 'tab-html',
          request: htmlRequest,
          response: htmlResponse,
          isDirty: false,
        },
      ],
      activeTabId: 'tab-html',
      isLoading: false,
    });
  });

  it('sandboxes the preview with a deny-by-default CSP while preserving response markup', () => {
    render(<ResponseViewer />);

    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));

    const preview = screen.getByTitle('HTML Preview');
    expect(preview).toHaveAttribute('sandbox', '');

    const srcDoc = preview.getAttribute('srcdoc') ?? '';
    const document = new DOMParser().parseFromString(srcDoc, 'text/html');
    const policy = document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute('content');

    expect(policy).toBe(
      "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; frame-src 'none'; img-src data:; manifest-src 'none'; media-src 'none'; object-src 'none'; script-src 'none'; style-src 'unsafe-inline'; worker-src 'none'"
    );
    expect(document.querySelector('h1')?.textContent).toBe('Safe response content');
    expect(document.querySelector('h1')?.getAttribute('style')).toBe('color: green');
    expect(document.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/gif/);
    expect(document.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(document.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(document.querySelector('form')?.hasAttribute('action')).toBe(false);
  });
});
