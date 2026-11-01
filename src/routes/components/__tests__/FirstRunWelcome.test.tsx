import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeAutoSend, queueAutoSend } from '@/features/http/lib/autoSend';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEMO_REQUEST_URL, FirstRunWelcome } from '../FirstRunWelcome';

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

function renderWelcome() {
  const props = {
    onRunDemo: vi.fn(),
    onNewRequest: vi.fn(),
    onOpenImport: vi.fn(),
    onTakeTour: vi.fn(),
    onDismiss: vi.fn(),
  };
  render(<FirstRunWelcome {...props} />);
  return props;
}

describe('FirstRunWelcome', () => {
  beforeEach(() => useCollectionStore.setState({ collections: [] }));
  afterEach(() => {
    act(() => {
      useSettingsStore.getState().updateSettings({ telemetry: { errorsEnabled: true } });
    });
  });

  it('shows the demo request and runs it on click', () => {
    const props = renderWelcome();
    expect(screen.getByText(DEMO_REQUEST_URL)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /run live demo/i }));
    expect(props.onRunDemo).toHaveBeenCalledOnce();
  });

  it('adds the sample collection and leaves the welcome screen', () => {
    const props = renderWelcome();
    fireEvent.click(screen.getByRole('button', { name: /open the sample collection/i }));
    expect(useCollectionStore.getState().collections).toHaveLength(1);
    expect(props.onDismiss).toHaveBeenCalledOnce();
  });

  it('routes import, tour and skip to their handlers', () => {
    const props = renderWelcome();
    fireEvent.click(screen.getByRole('button', { name: /bring your collections/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Take the tour' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip to workspace' }));
    expect(props.onOpenImport).toHaveBeenCalledOnce();
    expect(props.onTakeTour).toHaveBeenCalledOnce();
    expect(props.onDismiss).toHaveBeenCalledOnce();
  });

  it('starts a blank request per protocol, with raw-TCP protocols disabled on web', () => {
    const props = renderWelcome();
    fireEvent.click(screen.getByRole('button', { name: 'New gRPC request' }));
    expect(props.onNewRequest).toHaveBeenCalledWith('grpc');
    expect(screen.getByRole('button', { name: 'New Kafka request' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New MQTT request' })).toBeDisabled();
  });

  it('carries the crash-report opt-out the tour used to own', () => {
    renderWelcome();
    const toggle = screen.getByRole('switch', { name: 'Send crash and error reports' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().settings.telemetry?.errorsEnabled).toBe(false);
  });

  it('links to the docs quick start', () => {
    renderWelcome();
    expect(screen.getByRole('link', { name: /read the docs/i })).toHaveAttribute(
      'href',
      'https://docs.restura.dev/overview/quick-start/'
    );
  });

  it('offers the desktop download on web', () => {
    renderWelcome();
    expect(screen.getByRole('link', { name: /get the desktop app/i })).toHaveAttribute(
      'href',
      'https://github.com/dipjyotimetia/restura/releases/latest'
    );
  });
});

describe('autoSend queue', () => {
  it('fires once, and only for the queued tab', () => {
    queueAutoSend('tab-1');
    expect(consumeAutoSend('tab-2')).toBe(false);
    expect(consumeAutoSend(null)).toBe(false);
    expect(consumeAutoSend('tab-1')).toBe(true);
    expect(consumeAutoSend('tab-1')).toBe(false);
  });
});
