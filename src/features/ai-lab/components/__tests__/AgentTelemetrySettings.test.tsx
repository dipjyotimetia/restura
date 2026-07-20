import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiLabStore } from '../../store/useAiLabStore';
import { AgentTelemetrySettings } from '../AgentTelemetrySettings';

const store = vi.fn();
const setAgentTelemetryConfig = useAiLabStore.getState().setAgentTelemetryConfig;

describe('AgentTelemetrySettings', () => {
  beforeEach(() => {
    store.mockReset();
    window.electron = { secrets: { store } } as never;
    useAiLabStore.setState({ agentTelemetry: undefined, setAgentTelemetryConfig });
  });

  it('persists Langfuse keys as handles and never plaintext', async () => {
    store.mockResolvedValueOnce({ ok: true, id: '00000000-0000-4000-8000-000000000001' });
    store.mockResolvedValueOnce({ ok: true, id: '00000000-0000-4000-8000-000000000002' });
    render(<AgentTelemetrySettings />);
    fireEvent.change(screen.getByLabelText('Public key'), { target: { value: 'pk' } });
    fireEvent.change(screen.getByLabelText('Secret key'), { target: { value: 'sk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enable telemetry' }));
    await waitFor(() => expect(useAiLabStore.getState().agentTelemetry?.target).toBe('langfuse'));
    expect(JSON.stringify(useAiLabStore.getState().agentTelemetry)).not.toContain('sk');
  });

  it('validates sampling before storing credentials', () => {
    render(<AgentTelemetrySettings />);
    fireEvent.change(screen.getByLabelText('Sample rate (0–1)'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enable telemetry' }));
    expect(screen.getByText('Sampling must be a number from 0 to 1.')).toBeInTheDocument();
    expect(store).not.toHaveBeenCalled();
  });

  it('supports unauthenticated OTLP collectors and disable', async () => {
    render(<AgentTelemetrySettings />);
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'otlp' } });
    fireEvent.change(screen.getByLabelText('OTLP traces endpoint'), {
      target: { value: 'https://collector.example/v1/traces' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enable telemetry' }));
    await waitFor(() => expect(useAiLabStore.getState().agentTelemetry?.target).toBe('otlp'));
    expect(useAiLabStore.getState().agentTelemetry).toMatchObject({ auth: { mode: 'none' } });
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    expect(useAiLabStore.getState().agentTelemetry).toBeUndefined();
  });

  it('clears target-specific endpoint and credentials when switching telemetry targets', () => {
    render(<AgentTelemetrySettings />);
    fireEvent.change(screen.getByLabelText('Secret key'), { target: { value: 'langfuse-secret' } });
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'otlp' } });

    expect(screen.getByLabelText('OTLP traces endpoint')).toHaveValue('');
    expect(screen.getByLabelText('Bearer token (optional)')).toHaveValue('');
  });

  it('rejects incomplete Langfuse credentials and storage failures', async () => {
    render(<AgentTelemetrySettings />);
    fireEvent.change(screen.getByLabelText('Public key'), { target: { value: 'pk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enable telemetry' }));
    expect(screen.getByText('Enter Langfuse public and secret keys.')).toBeInTheDocument();

    store.mockResolvedValueOnce({ ok: false });
    store.mockResolvedValueOnce({ ok: true, id: '00000000-0000-4000-8000-000000000002' });
    fireEvent.change(screen.getByLabelText('Secret key'), { target: { value: 'sk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enable telemetry' }));
    expect(await screen.findByText('Could not store telemetry credentials.')).toBeInTheDocument();
  });

  it('stores an optional OTLP bearer token as a SecretRef', async () => {
    store.mockResolvedValue({ ok: true, id: '00000000-0000-4000-8000-000000000003' });
    render(<AgentTelemetrySettings />);
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'otlp' } });
    fireEvent.change(screen.getByLabelText('OTLP traces endpoint'), {
      target: { value: 'https://collector.example/v1/traces' },
    });
    fireEvent.change(screen.getByLabelText('Bearer token (optional)'), {
      target: { value: 'token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enable telemetry' }));

    await waitFor(() =>
      expect(useAiLabStore.getState().agentTelemetry).toMatchObject({
        auth: { mode: 'bearer', token: { source: 'secret-handle' } },
      })
    );
  });

  it('reports an OTLP token storage failure', async () => {
    store.mockResolvedValue({ ok: false });
    render(<AgentTelemetrySettings />);
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'otlp' } });
    fireEvent.change(screen.getByLabelText('OTLP traces endpoint'), {
      target: { value: 'https://collector.example/v1/traces' },
    });
    fireEvent.change(screen.getByLabelText('Bearer token (optional)'), {
      target: { value: 'token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enable telemetry' }));

    expect(await screen.findByText('Could not store the OTLP token.')).toBeInTheDocument();
  });

  it('does nothing when the Electron bridge is unavailable', () => {
    window.electron = undefined;
    render(<AgentTelemetrySettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Enable telemetry' }));
    expect(useAiLabStore.getState().agentTelemetry).toBeUndefined();
  });

  it('surfaces non-Error configuration failures without leaking credentials', async () => {
    useAiLabStore.setState({
      setAgentTelemetryConfig: () => {
        throw 'Telemetry configuration is unavailable';
      },
    });
    render(<AgentTelemetrySettings />);
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'otlp' } });
    fireEvent.change(screen.getByLabelText('OTLP traces endpoint'), {
      target: { value: 'https://collector.example/v1/traces' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enable telemetry' }));

    expect(await screen.findByText('Telemetry configuration is unavailable')).toBeInTheDocument();
  });
});
