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
