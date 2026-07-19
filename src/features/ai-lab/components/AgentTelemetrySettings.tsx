import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { AgentTelemetryConfigSchema } from '@shared/agent-lab/telemetry-config';
import { useAiLabStore } from '../store/useAiLabStore';

/** Opt-in metadata-only agent telemetry configuration. Credentials are stored
 * as main-process SecretRef handles and never enter persisted renderer state. */
export function AgentTelemetrySettings() {
  const configured = useAiLabStore((state) => state.agentTelemetry);
  const setConfig = useAiLabStore((state) => state.setAgentTelemetryConfig);
  const [target, setTarget] = useState<'langfuse' | 'otlp'>(configured?.target ?? 'langfuse');
  const [endpoint, setEndpoint] = useState(
    configured?.target === 'langfuse'
      ? configured.baseUrl
      : configured?.target === 'otlp'
        ? configured.endpoint
        : 'https://cloud.langfuse.com'
  );
  const [environment, setEnvironment] = useState(configured?.environment ?? 'development');
  const [sampleRate, setSampleRate] = useState(String(configured?.sampleRate ?? 1));
  const [publicKey, setPublicKey] = useState('');
  const [secret, setSecret] = useState('');
  const [message, setMessage] = useState('Disabled by default; content is never exported.');

  const save = async () => {
    if (!window.electron) return;
    const rate = Number(sampleRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      setMessage('Sampling must be a number from 0 to 1.');
      return;
    }
    try {
      if (target === 'langfuse') {
        if (!publicKey || !secret) throw new Error('Enter Langfuse public and secret keys.');
        const [storedPublic, storedSecret] = await Promise.all([
          window.electron.secrets.store({
            value: publicKey,
            label: 'Langfuse public key',
            scope: 'agent-telemetry',
          }),
          window.electron.secrets.store({
            value: secret,
            label: 'Langfuse secret key',
            scope: 'agent-telemetry',
          }),
        ]);
        if (!storedPublic.ok || !storedSecret.ok)
          throw new Error('Could not store telemetry credentials.');
        setConfig(
          AgentTelemetryConfigSchema.parse({
            enabled: true,
            target,
            baseUrl: endpoint,
            publicKey: { source: 'secret-handle', id: storedPublic.id },
            secretKey: { source: 'secret-handle', id: storedSecret.id },
            environment,
            sampleRate: rate,
          })
        );
      } else {
        const auth = secret
          ? await window.electron.secrets.store({
              value: secret,
              label: 'OTLP bearer token',
              scope: 'agent-telemetry',
            })
          : undefined;
        if (auth && !auth.ok) throw new Error('Could not store the OTLP token.');
        setConfig(
          AgentTelemetryConfigSchema.parse({
            enabled: true,
            target,
            endpoint,
            environment,
            sampleRate: rate,
            auth: auth
              ? { mode: 'bearer', token: { source: 'secret-handle', id: auth.id } }
              : { mode: 'none' },
          })
        );
      }
      setPublicKey('');
      setSecret('');
      setMessage('Enabled. Only metadata from future agent runs will be exported.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <details className="mt-3 rounded-sp-card border border-sp-line bg-sp-surface-lo p-3">
      <summary className="cursor-pointer text-sp-11 font-semibold">Agent telemetry</summary>
      <p className="mt-1 text-sp-9 text-sp-muted">
        Model/tool metadata and aggregate scores only. Prompts, responses, URLs, bodies, headers and
        errors stay local.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-sp-9 text-sp-muted">
          Target
          <select
            value={target}
            onChange={(event) => setTarget(event.target.value as 'langfuse' | 'otlp')}
            className="mt-1 w-full rounded border border-sp-line bg-sp-bg p-1.5 text-sp-11 text-sp-text"
          >
            <option value="langfuse">Langfuse</option>
            <option value="otlp">Generic OTLP/HTTP</option>
          </select>
        </label>
        <label className="text-sp-9 text-sp-muted">
          Environment
          <input
            value={environment}
            onChange={(event) => setEnvironment(event.target.value)}
            className="mt-1 w-full rounded border border-sp-line bg-sp-bg p-1.5 text-sp-11 text-sp-text"
          />
        </label>
        <label className="text-sp-9 text-sp-muted">
          {target === 'langfuse' ? 'Langfuse base URL' : 'OTLP traces endpoint'}
          <input
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            className="mt-1 w-full rounded border border-sp-line bg-sp-bg p-1.5 text-sp-11 text-sp-text"
          />
        </label>
        <label className="text-sp-9 text-sp-muted">
          Sample rate (0–1)
          <input
            value={sampleRate}
            onChange={(event) => setSampleRate(event.target.value)}
            inputMode="decimal"
            className="mt-1 w-full rounded border border-sp-line bg-sp-bg p-1.5 text-sp-11 text-sp-text"
          />
        </label>
        {target === 'langfuse' && (
          <label className="text-sp-9 text-sp-muted">
            Public key
            <input
              value={publicKey}
              onChange={(event) => setPublicKey(event.target.value)}
              className="mt-1 w-full rounded border border-sp-line bg-sp-bg p-1.5 text-sp-11 text-sp-text"
            />
          </label>
        )}
        <label className="text-sp-9 text-sp-muted">
          {target === 'langfuse' ? 'Secret key' : 'Bearer token (optional)'}
          <input
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            type="password"
            className="mt-1 w-full rounded border border-sp-line bg-sp-bg p-1.5 text-sp-11 text-sp-text"
          />
        </label>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" onClick={() => void save()}>
          Enable telemetry
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setConfig(undefined);
            setMessage('Disabled.');
          }}
        >
          Disable
        </Button>
        <span className="text-sp-9 text-sp-muted">{message}</span>
      </div>
    </details>
  );
}
