/** #914 — the per-request wire protocol selector in the gRPC Settings tab. */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ electron: false }));
vi.mock('@/lib/shared/platform', async (orig) => ({
  ...(await orig<typeof import('@/lib/shared/platform')>()),
  isElectron: () => platform.electron,
}));

import { GrpcSettingsPanel } from '../GrpcSettingsPanel';

function renderPanel(wireProtocol?: 'grpc' | 'connect' | 'grpc-web' | 'grpc-web-text') {
  const onWireProtocolChange = vi.fn();
  render(
    <GrpcSettingsPanel
      retryMaxAttempts={1}
      retryDelayMs={0}
      useCompression={false}
      onRetryMaxAttemptsChange={vi.fn()}
      onRetryDelayMsChange={vi.fn()}
      onUseCompressionChange={vi.fn()}
      wireProtocol={wireProtocol}
      onWireProtocolChange={onWireProtocolChange}
    />
  );
  return onWireProtocolChange;
}

describe('GrpcSettingsPanel wire protocol', () => {
  it('web offers gRPC-Web (binary + text) and Connect, not native gRPC', () => {
    platform.electron = false;
    const onChange = renderPanel();
    const group = screen.getByRole('radiogroup', { name: 'gRPC wire protocol' });
    expect(group).toHaveTextContent('gRPC-Web text');
    expect(screen.queryByRole('radio', { name: 'gRPC' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'gRPC-Web' }));
    expect(onChange).toHaveBeenCalledWith('grpc-web');
  });

  it('desktop offers native gRPC but not the text mode; Auto clears the field', () => {
    platform.electron = true;
    const onChange = renderPanel('grpc-web');
    expect(screen.getByRole('radio', { name: 'gRPC' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'gRPC-Web text' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'gRPC-Web' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Auto' }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});

describe('GrpcSettingsPanel wire protocol hints', () => {
  it.each([
    [false, undefined, /Connect JSON through the Restura proxy/],
    [true, undefined, /falling back to Connect/],
    [false, 'grpc', /Native gRPC needs the desktop app/],
    [true, 'grpc', /HTTP\/2 only — no fallback/],
    [false, 'grpc-web', /application\/grpc-web\+proto/],
    [false, 'grpc-web-text', /application\/grpc-web-text/],
    [true, 'grpc-web-text', /available on the web app only/],
    [true, 'connect', /Connect protocol only/],
  ] as const)('electron=%s wire=%s explains the transport', (electron, wire, hint) => {
    platform.electron = electron;
    renderPanel(wire);
    expect(screen.getByText(hint)).toBeInTheDocument();
  });
});

describe('GrpcSettingsPanel retry and compression', () => {
  function renderSettings(props: { retryMaxAttempts: number; useCompression?: boolean }) {
    const handlers = {
      onRetryMaxAttemptsChange: vi.fn(),
      onRetryDelayMsChange: vi.fn(),
      onUseCompressionChange: vi.fn(),
    };
    render(
      <GrpcSettingsPanel
        retryMaxAttempts={props.retryMaxAttempts}
        retryDelayMs={250}
        useCompression={props.useCompression ?? false}
        {...handlers}
      />
    );
    return handlers;
  }

  it('clamps retry attempts to 1–10 and the delay to non-negative numbers', () => {
    platform.electron = true;
    const h = renderSettings({ retryMaxAttempts: 1 });
    const attempts = screen.getByLabelText('Max retry attempts');
    fireEvent.change(attempts, { target: { value: '42' } });
    fireEvent.change(attempts, { target: { value: '' } });
    expect(h.onRetryMaxAttemptsChange.mock.calls).toEqual([[10], [1]]);
    const delay = screen.getByLabelText('Retry delay in milliseconds');
    fireEvent.change(delay, { target: { value: '-5' } });
    fireEvent.change(delay, { target: { value: '' } });
    expect(h.onRetryDelayMsChange.mock.calls).toEqual([[0], [0]]);
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('summarises the retry policy with the right plural', () => {
    platform.electron = true;
    renderSettings({ retryMaxAttempts: 2 });
    expect(
      screen.getByText(/Will retry up to 1 time\s+on failure, waiting 250ms/)
    ).toBeInTheDocument();
  });

  it('pluralises several retries and warns that web cannot compress', () => {
    platform.electron = false;
    renderSettings({ retryMaxAttempts: 4, useCompression: true });
    expect(screen.getByText(/Will retry up to 3 time\s*s on failure/)).toBeInTheDocument();
    expect(
      screen.getByText('Compression is only supported in the Electron desktop app.')
    ).toBeInTheDocument();
  });
});
