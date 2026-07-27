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

  it('renders empty, loading, and response metadata states without a stale response', () => {
    useRequestStore.setState({ tabs: [], activeTabId: null, isLoading: false });
    const { rerender } = render(<ResponseViewer />);
    expect(screen.getByText('Send a request to see the response')).toBeInTheDocument();

    useRequestStore.setState({ isLoading: true });
    rerender(<ResponseViewer />);
    expect(document.querySelectorAll('[class*="animate"]').length).toBeGreaterThan(0);

    useRequestStore.setState({
      tabs: [
        {
          id: 'tab-response',
          request: htmlRequest,
          response: {
            ...htmlResponse,
            id: 'response-status',
            status: 503,
            statusText: 'Unavailable',
            negotiatedAlpn: 'h2',
          },
          isDirty: false,
        },
      ],
      activeTabId: 'tab-response',
      isLoading: false,
    });
    rerender(<ResponseViewer />);
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText('HTTP')).toBeInTheDocument();
    expect(screen.getByText('HTTP/2')).toBeInTheDocument();
  });

  it('renders filtered headers, parsed cookies, and server timing details', () => {
    const headers = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`x-header-${index}`, `value-${index}`])
    );
    useRequestStore.setState({
      tabs: [
        {
          id: 'tab-details',
          request: htmlRequest,
          response: {
            ...htmlResponse,
            id: 'response-details',
            headers: {
              ...headers,
              'set-cookie': ['session=abc; HttpOnly; Secure', 'flag'],
              'server-timing': 'db;dur=12.5;desc="primary", cache;desc="warm"',
            },
          },
          isDirty: false,
        },
      ],
      activeTabId: 'tab-details',
      isLoading: false,
    });
    render(<ResponseViewer />);

    fireEvent.click(screen.getByRole('tab', { name: /Headers/ }));
    const filter = screen.getByRole('textbox', { name: 'Filter response headers' });
    fireEvent.change(filter, { target: { value: 'x-header-2' } });
    expect(screen.getByText('x-header-2')).toBeInTheDocument();
    expect(screen.queryByText('x-header-3')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /Cookies/ }));
    expect(screen.getByText('session')).toBeInTheDocument();
    expect(screen.getByText('abc')).toBeInTheDocument();
    expect(screen.getByText('HttpOnly · Secure')).toBeInTheDocument();
    expect(screen.getByText('flag')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(screen.getByText('primary')).toBeInTheDocument();
    expect(screen.getByText('12.5 ms')).toBeInTheDocument();
    expect(screen.getByText('warm')).toBeInTheDocument();
  });

  it('selects CSV tables and binary download affordances from response metadata', () => {
    useRequestStore.setState({
      tabs: [
        {
          id: 'tab-csv',
          request: htmlRequest,
          response: {
            ...htmlResponse,
            id: 'response-csv',
            headers: { 'content-type': 'text/csv' },
            body: 'name,value\nfirst,1',
          },
          isDirty: false,
        },
      ],
      activeTabId: 'tab-csv',
      isLoading: false,
    });
    const { rerender } = render(<ResponseViewer />);
    expect(screen.getByRole('button', { name: 'Download response' })).toBeInTheDocument();

    useRequestStore.setState({
      tabs: [
        {
          id: 'tab-binary',
          request: htmlRequest,
          response: {
            ...htmlResponse,
            id: 'response-binary',
            headers: { 'content-type': 'application/pdf' },
            body: 'cGRm',
            bodyEncoding: 'base64',
          },
          isDirty: false,
        },
      ],
      activeTabId: 'tab-binary',
    });
    rerender(<ResponseViewer />);
    expect(screen.getByText(/Binary response/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Download file' }).length).toBeGreaterThan(0);
  });
});
