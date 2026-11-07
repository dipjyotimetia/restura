import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRequestStore } from '@/store/useRequestStore';
import type { HttpRequest, Response } from '@/types';

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: toastMocks }));

vi.mock('@/lib/shared/lazyComponent', () => ({
  lazyComponent: () => (props: { value?: string; language?: string }) => (
    <div data-testid="lazy-component" data-language={props.language ?? ''} />
  ),
}));

vi.mock('@/features/ai/components/AiActionsMenu', () => ({
  AiActionsMenu: () => null,
}));

import ResponseViewer from '../ResponseViewer';

const request: HttpRequest = {
  id: 'req',
  name: 'R',
  type: 'http',
  method: 'GET',
  url: 'https://example.test',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
};

const okResponse: Response = {
  id: 'resp-ok',
  requestId: request.id,
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  body: '{"a":1}',
  size: 7,
  time: 5,
  timestamp: 1,
};

function showResponse(response: Response) {
  act(() => {
    useRequestStore.setState({
      tabs: [{ id: 'tab', request, response, isDirty: false }],
      activeTabId: 'tab',
      isLoading: false,
    });
  });
}

describe('ResponseViewer usability', () => {
  beforeEach(() => {
    toastMocks.success.mockReset();
    toastMocks.error.mockReset();
    toastMocks.info.mockReset();
    showResponse(okResponse);
  });

  it('switches to the Body tab when a new response is a transport failure (H3)', () => {
    render(<ResponseViewer />);
    fireEvent.click(screen.getByRole('tab', { name: /Headers/ }));
    expect(screen.getByRole('tab', { name: /Headers/ })).toHaveAttribute('aria-selected', 'true');

    showResponse({
      ...okResponse,
      id: 'resp-fail',
      status: 0,
      statusText: 'Error',
      headers: {},
      body: 'Request timeout after 30000ms',
    });

    expect(screen.getByRole('tab', { name: /Body/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Request timed out');
  });

  it('copies the raw body from the Tree view instead of an empty string (H4)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ResponseViewer />);
    fireEvent.click(screen.getByRole('radio', { name: 'Tree' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy response body' }));
    });
    expect(writeText).toHaveBeenCalledWith('{"a":1}');
    expect(toastMocks.success).toHaveBeenCalled();
  });

  it('flags a large non-JSON body and turns off highlighting (H11)', () => {
    const big = 'x'.repeat(1_000_001);
    showResponse({
      ...okResponse,
      id: 'resp-big-text',
      headers: { 'content-type': 'application/xml' },
      body: big,
      size: big.length,
    });
    render(<ResponseViewer />);
    expect(screen.getByRole('status')).toHaveTextContent(/Large body/i);
    expect(screen.getByTestId('lazy-component')).toHaveAttribute('data-language', 'plaintext');
  });

  it('flags a large JSON body in the Raw view too (H11)', () => {
    const big = JSON.stringify({ items: Array.from({ length: 100000 }, (_, i) => ({ i })) });
    showResponse({ ...okResponse, id: 'resp-big-json', body: big, size: big.length });
    render(<ResponseViewer />);
    fireEvent.click(screen.getByRole('radio', { name: 'Raw' }));
    expect(screen.getByRole('status')).toHaveTextContent(/Large body/i);
    expect(screen.getByTestId('lazy-component')).toHaveAttribute('data-language', 'plaintext');
  });
});
