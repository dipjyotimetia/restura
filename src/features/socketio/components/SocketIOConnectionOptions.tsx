import { type ReactNode, useId } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { KeyValueTable } from '@/components/shared/KeyValueTable';
import { Input } from '@/components/ui/input';
import { CodeEditorFrame, ToggleField } from '@/components/ui/spatial';
import { parseAuthJson } from '@/features/socketio/lib/socketioManager';
import {
  type SocketIOConnection,
  type SocketIOTransport,
  useSocketIOStore,
} from '@/features/socketio/store/useSocketIOStore';
import { isElectron } from '@/lib/shared/platform';
import { cn } from '@/lib/shared/utils';

const TRANSPORTS: SocketIOTransport[] = ['websocket', 'polling'];

/** How many options differ from a fresh connection — drives the Options toggle count. */
export function countConfiguredOptions(c: SocketIOConnection): number {
  return (
    (c.authMode === 'json'
      ? c.authJson.trim() && c.authJson.trim() !== '{}'
        ? 1
        : 0
      : c.auth.length) +
    c.query.length +
    c.extraHeaders.length +
    (c.path && c.path !== '/socket.io' ? 1 : 0) +
    (c.transports.length === 1 ? 1 : 0) +
    (c.forceNew ? 1 : 0)
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex flex-col gap-1">
      <span className="text-sp-11 text-sp-muted">{label}</span>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : ''}
        disabled={disabled}
        onChange={(e) => {
          const raw = Number(e.target.value);
          if (e.target.value === '' || !Number.isFinite(raw)) return;
          // Integer fields (step 1) must stay integers — the desktop IPC schema rejects fractions.
          const n = step === 1 ? Math.round(raw) : raw;
          onChange(Math.min(max, Math.max(min, n)));
        }}
        className="h-7 w-28 bg-sp-surface-lo border border-sp-line px-2 font-mono text-sp-12 text-sp-text"
      />
    </label>
  );
}

const SectionLabel = ({ children }: { children: ReactNode }) => (
  <span className="text-sp-11 font-medium text-sp-muted">{children}</span>
);

/**
 * Connection options pane (SIO-3/4): handshake auth (key/value or JSON),
 * query, extraHeaders, path, transports, reconnection tuning, timeout and
 * forceNew. Edited while disconnected; persisted with the connection
 * (templates stored unresolved).
 */
export function SocketIOConnectionOptions({ connection }: { connection: SocketIOConnection }) {
  const { setKv, update } = useSocketIOStore(
    useShallow((s) => ({ setKv: s.setKv, update: s.updateConnectionField }))
  );
  const id = connection.id;
  const authJsonError =
    connection.authMode === 'json' && !/\{\{/.test(connection.authJson)
      ? (() => {
          const parsed = parseAuthJson(connection.authJson);
          return parsed.ok ? null : parsed.error;
        })()
      : null;
  const headersIgnoredOnWeb =
    !isElectron() &&
    connection.extraHeaders.length > 0 &&
    !connection.transports.every((t) => t === 'polling');

  const toggleTransport = (t: SocketIOTransport, on: boolean) => {
    const next = on
      ? TRANSPORTS.filter((x) => x === t || connection.transports.includes(x))
      : connection.transports.filter((x) => x !== t);
    // At least one transport is required.
    if (next.length > 0) update(id, 'transports', next);
  };

  return (
    <div className="flex flex-col gap-3" data-testid="socketio-connection-options">
      <div>
        <div className="flex items-center gap-2">
          <SectionLabel>Auth (handshake payload)</SectionLabel>
          <div className="flex-1" />
          {(['kv', 'json'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={connection.authMode === mode}
              onClick={() => update(id, 'authMode', mode)}
              className={cn(
                'h-6 px-2 rounded-sp-chip font-mono text-sp-11 border border-sp-line',
                connection.authMode === mode
                  ? 'bg-sp-active text-sp-text'
                  : 'text-sp-muted hover:bg-sp-hover'
              )}
            >
              {mode === 'kv' ? 'Key/value' : 'JSON'}
            </button>
          ))}
        </div>
        <div className="mt-1">
          {connection.authMode === 'kv' ? (
            // Key/value auth is sent as typed — no {{var}} resolution.
            <KeyValueTable
              items={connection.auth}
              onChange={(items) => setKv(id, 'auth', items)}
              itemLabel="auth field"
              addLabel="Add auth field"
            />
          ) : (
            <>
              <CodeEditorFrame gutter={false} className="h-28">
                <textarea
                  value={connection.authJson}
                  onChange={(e) => update(id, 'authJson', e.target.value)}
                  placeholder={'{ "token": "{{token}}", "user": { "id": 1 } }'}
                  aria-label="Auth payload (JSON)"
                  spellCheck={false}
                  className="block h-full w-full resize-none bg-transparent text-sp-text font-mono text-sp-12 outline-none placeholder:text-sp-dim"
                />
              </CodeEditorFrame>
              <p
                className="mt-1 font-mono text-sp-11"
                style={{ color: authJsonError ? 'var(--color-danger)' : undefined }}
              >
                {authJsonError
                  ? `JSON error: ${authJsonError}`
                  : 'Any JSON object. {{variables}} are resolved at connect time.'}
              </p>
            </>
          )}
        </div>
      </div>

      <div>
        <SectionLabel>Query params</SectionLabel>
        <div className="mt-1">
          <KeyValueTable
            items={connection.query}
            onChange={(items) => setKv(id, 'query', items)}
            itemLabel="query param"
            addLabel="Add query param"
          />
        </div>
      </div>

      <div>
        <SectionLabel>Headers (extraHeaders)</SectionLabel>
        <div className="mt-1">
          <KeyValueTable
            items={connection.extraHeaders}
            onChange={(items) => setKv(id, 'extraHeaders', items)}
            itemLabel="header"
            addLabel="Add header"
          />
        </div>
        {headersIgnoredOnWeb && (
          <p className="mt-1 text-sp-11" style={{ color: 'var(--color-warning)' }}>
            Browsers drop custom headers on the WebSocket transport — use polling only, or the
            desktop app.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-sp-11 text-sp-muted">Path</span>
          <Input
            value={connection.path}
            onChange={(e) => update(id, 'path', e.target.value)}
            onBlur={(e) => {
              const v = e.target.value.trim();
              update(id, 'path', !v ? '/socket.io' : v.startsWith('/') ? v : `/${v}`);
            }}
            placeholder="/socket.io"
            aria-label="Engine.IO path"
            className="h-7 w-40 bg-sp-surface-lo border border-sp-line px-2 font-mono text-sp-12 text-sp-text"
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-sp-11 text-sp-muted">Transports</span>
          <div className="flex items-center gap-3 h-7">
            {TRANSPORTS.map((t) => (
              <span key={t} className="flex items-center gap-1.5">
                <ToggleField
                  size="sm"
                  checked={connection.transports.includes(t)}
                  onChange={(on) => toggleTransport(t, on)}
                  ariaLabel={`Transport ${t}`}
                />
                <span className="font-mono text-sp-12 text-sp-text">{t}</span>
              </span>
            ))}
          </div>
        </div>
        <NumberField
          label="Timeout (ms)"
          value={connection.timeout}
          min={1}
          max={120_000}
          onChange={(v) => update(id, 'timeout', v)}
        />
        <div className="flex flex-col gap-1">
          <span className="text-sp-11 text-sp-muted">Force new</span>
          <span className="flex items-center h-7">
            <ToggleField
              size="sm"
              checked={connection.forceNew}
              onChange={(v) => update(id, 'forceNew', v)}
              ariaLabel="Force new connection"
            />
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-sp-11 text-sp-muted">Reconnection</span>
          <span className="flex items-center h-7">
            <ToggleField
              size="sm"
              checked={connection.autoReconnect}
              onChange={(v) => update(id, 'autoReconnect', v)}
              ariaLabel="Reconnection"
            />
          </span>
        </div>
        <NumberField
          label="Attempts"
          value={connection.reconnectionAttempts}
          min={0}
          max={100}
          disabled={!connection.autoReconnect}
          onChange={(v) => update(id, 'reconnectionAttempts', v)}
        />
        <NumberField
          label="Delay (ms)"
          value={connection.reconnectionDelay}
          min={0}
          max={60_000}
          disabled={!connection.autoReconnect}
          onChange={(v) => update(id, 'reconnectionDelay', v)}
        />
        <NumberField
          label="Max delay (ms)"
          value={connection.reconnectionDelayMax}
          min={0}
          max={300_000}
          disabled={!connection.autoReconnect}
          onChange={(v) => update(id, 'reconnectionDelayMax', v)}
        />
        <NumberField
          label="Randomization"
          value={connection.randomizationFactor}
          min={0}
          max={1}
          step={0.1}
          disabled={!connection.autoReconnect}
          onChange={(v) => update(id, 'randomizationFactor', v)}
        />
      </div>
    </div>
  );
}
