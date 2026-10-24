import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import type { KafkaConnectionFormController } from '../../hooks/useKafkaConnection';
import type { KafkaConnection, KafkaRegistry } from '../../store/useKafkaStore';
import { KAFKA_SECRET_SENTINEL } from '../../store/useKafkaStore';
import { KafkaConnectionForm } from '../KafkaConnectionForm';

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

// SecretInput is exercised by its own suite; here it only needs to report what
// the form passes in and let the test emit inline / handle values.
vi.mock('@/features/auth/components/SecretInput', () => ({
  default: ({
    value,
    placeholder,
    scope,
    onChange,
  }: {
    value: unknown;
    placeholder?: string;
    scope?: string;
    onChange: (next: unknown) => void;
  }) => (
    <div>
      <span data-testid="secret-value">{JSON.stringify(value)}</span>
      <span data-testid="secret-scope">{scope}</span>
      <span>{placeholder}</span>
      <button type="button" onClick={() => onChange('typed-token')}>
        Type token
      </button>
      <button type="button" onClick={() => onChange({ kind: 'handle', id: 'h-1' })}>
        Use handle
      </button>
      <button type="button" onClick={() => onChange({ kind: 'inline', value: '' })}>
        Replace
      </button>
    </div>
  ),
}));

const baseConnection: KafkaConnection = {
  id: 'connection-1',
  name: 'Orders cluster',
  clientId: 'restura-test',
  bootstrapBrokers: ['localhost:9092'],
  auth: { securityProtocol: 'PLAINTEXT' },
  status: 'disconnected',
  defaultTopic: 'orders',
  defaultPartitionKey: '',
  acks: 1,
  compression: 'none',
  idempotent: false,
  consumer: {
    groupId: 'g',
    topics: [],
    fromBeginning: false,
    mode: 'committed',
    fallbackMode: 'latest',
    commitPolicy: 'auto',
    isolation: 'read-uncommitted',
    groupProtocol: 'classic',
    status: 'idle',
  },
  messages: [],
  createdAt: 0,
};

function renderForm(
  registry: KafkaRegistry | undefined,
  tokenDraft = '',
  overrides: Partial<KafkaConnection> = {}
) {
  const controller = {
    updateConnection: vi.fn(),
    updateAuth: vi.fn(),
    brokerDraft: '',
    setBrokerDraft: vi.fn(),
    saslPasswordDraft: '',
    setSaslPasswordDraft: vi.fn(),
    tlsPassphraseDraft: '',
    setTlsPassphraseDraft: vi.fn(),
    registryPasswordDraft: '',
    setRegistryPasswordDraft: vi.fn(),
    registryTokenDraft: tokenDraft,
    setRegistryTokenDraft: vi.fn(),
    secretDrafts: {},
    setSecretDraft: vi.fn(),
    replaceSasl: vi.fn(),
    patchRegistry: vi.fn(),
    addBroker: vi.fn(),
    removeBroker: vi.fn(),
    pickTlsFile: vi.fn(),
    setSecurityProtocol: vi.fn(),
  } satisfies KafkaConnectionFormController;
  render(
    <Tabs value="connection">
      <KafkaConnectionForm
        connection={{ ...baseConnection, ...(registry ? { registry } : {}), ...overrides }}
        controller={controller}
      />
    </Tabs>
  );
  return controller;
}

describe('KafkaConnectionForm — Schema Registry auth', () => {
  it('keeps HTTP Basic as the default and switches to bearer', async () => {
    const user = userEvent.setup();
    const controller = renderForm({ url: 'https://registry.example.test' });
    expect(screen.getByPlaceholderText('Username (optional)')).toBeVisible();
    expect(screen.getByText(/Settings → Certificates/)).toBeVisible();

    const authSelect = screen.getAllByRole('combobox').at(-1)!;
    expect(authSelect).toHaveValue('basic');
    await user.selectOptions(authSelect, 'bearer');
    expect(controller.patchRegistry).toHaveBeenCalledWith({ authType: 'bearer' });
  });

  it('edits an inline bearer token as a draft and stores handles by reference', async () => {
    const user = userEvent.setup();
    const controller = renderForm(
      { url: 'https://r.test', authType: 'bearer', bearerToken: KAFKA_SECRET_SENTINEL },
      'draft'
    );
    expect(screen.getByTestId('secret-value')).toHaveTextContent('"draft"');
    expect(screen.getByTestId('secret-scope')).toHaveTextContent('kafka');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Token (stored — leave blank to keep)')).toBeVisible();
    expect(screen.queryByPlaceholderText('Username (optional)')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Type token' }));
    expect(controller.setRegistryTokenDraft).toHaveBeenCalledWith('typed-token');
    expect(controller.patchRegistry).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Use handle' }));
    expect(controller.patchRegistry).toHaveBeenCalledWith({
      bearerToken: { kind: 'handle', id: 'h-1' },
    });
    expect(controller.setRegistryTokenDraft).toHaveBeenLastCalledWith('');
  });

  it('shows a stored handle and clears it when replaced with an inline value', async () => {
    const user = userEvent.setup();
    const handle = { kind: 'handle' as const, id: 'h-9' };
    const controller = renderForm({
      url: 'https://r.test',
      authType: 'bearer',
      bearerToken: handle,
    });
    expect(screen.getByTestId('secret-value')).toHaveTextContent('"kind":"handle"');
    expect(screen.getByText('Bearer token', { selector: 'span' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Replace' }));
    expect(controller.setRegistryTokenDraft).toHaveBeenCalledWith('');
    expect(controller.patchRegistry).toHaveBeenCalledWith({ bearerToken: undefined });
  });

  it('edits Basic credentials and shows a stored password hint', async () => {
    const user = userEvent.setup();
    const controller = renderForm({
      url: 'https://r.test',
      auth: { username: 'u', password: KAFKA_SECRET_SENTINEL },
    });
    expect(screen.getByPlaceholderText('Password (stored — leave blank to keep)')).toBeVisible();
    await user.type(screen.getByPlaceholderText('Username (optional)'), 'x');
    expect(controller.patchRegistry).toHaveBeenLastCalledWith({
      auth: { username: 'ux', password: KAFKA_SECRET_SENTINEL },
    });
    await user.type(screen.getByPlaceholderText('Password (stored — leave blank to keep)'), 'p');
    expect(controller.setRegistryPasswordDraft).toHaveBeenLastCalledWith('p');
    await user.type(screen.getByPlaceholderText('https://schema-registry:8081'), '/');
    expect(controller.patchRegistry).toHaveBeenLastCalledWith({ url: 'https://r.test/' });
  });

  it('toggles the registry on and off', async () => {
    const user = userEvent.setup();
    const off = renderForm(undefined);
    await user.click(screen.getAllByRole('switch').at(-1)!);
    expect(off.updateConnection).toHaveBeenCalledWith('connection-1', { registry: { url: '' } });
  });
});

describe('KafkaConnectionForm — broker auth', () => {
  it('drives SASL/PLAIN + TLS fields with stored-secret hints', async () => {
    const user = userEvent.setup();
    const controller = renderForm(undefined, '', {
      auth: {
        securityProtocol: 'SASL_SSL',
        sasl: { mechanism: 'PLAIN', username: 'alice', password: KAFKA_SECRET_SENTINEL },
        tls: { caPath: '/ca.pem', passphrase: KAFKA_SECRET_SENTINEL, rejectUnauthorized: false },
      },
    });
    expect(screen.getByPlaceholderText('Password (stored — leave blank to keep)')).toBeVisible();
    expect(
      screen.getByPlaceholderText('Key passphrase (stored — leave blank to keep)')
    ).toBeVisible();
    expect(screen.getByDisplayValue('/ca.pem')).toBeVisible();

    await user.type(screen.getByPlaceholderText('Username'), 'z');
    expect(controller.updateAuth).toHaveBeenLastCalledWith(
      'connection-1',
      expect.objectContaining({
        sasl: { mechanism: 'PLAIN', username: 'alicez', password: KAFKA_SECRET_SENTINEL },
      })
    );
    await user.type(screen.getByPlaceholderText('Password (stored — leave blank to keep)'), 's');
    expect(controller.setSaslPasswordDraft).toHaveBeenLastCalledWith('s');
    await user.type(
      screen.getByPlaceholderText('Key passphrase (stored — leave blank to keep)'),
      'k'
    );
    expect(controller.setTlsPassphraseDraft).toHaveBeenLastCalledWith('k');
    await user.click(screen.getAllByRole('button', { name: 'Browse' })[1]!);
    expect(controller.pickTlsFile).toHaveBeenCalledWith('certPath');

    const switches = screen.getAllByRole('switch');
    await user.click(switches.find((s) => s.getAttribute('aria-checked') === 'false')!);
    expect(controller.updateAuth).toHaveBeenLastCalledWith(
      'connection-1',
      expect.objectContaining({ tls: expect.objectContaining({ rejectUnauthorized: true }) })
    );

    await user.selectOptions(screen.getAllByRole('combobox')[1]!, 'OAUTHBEARER');
    expect(controller.replaceSasl).toHaveBeenLastCalledWith({
      mechanism: 'OAUTHBEARER',
      mode: 'static',
      token: '',
    });
    await user.selectOptions(screen.getAllByRole('combobox')[1]!, 'SCRAM-SHA-256');
    expect(controller.replaceSasl).toHaveBeenLastCalledWith({
      mechanism: 'SCRAM-SHA-256',
      username: '',
      password: '',
    });
    await user.selectOptions(screen.getAllByRole('combobox')[0]!, 'SSL');
    expect(controller.setSecurityProtocol).toHaveBeenCalledWith('SSL');
  });

  it('labels OAUTHBEARER tokens and fresh TLS passphrases', () => {
    renderForm(undefined, '', {
      auth: { securityProtocol: 'SASL_PLAINTEXT', sasl: { mechanism: 'OAUTHBEARER', token: '' } },
    });
    expect(screen.getByPlaceholderText('Bearer token')).toBeVisible();
    expect(screen.queryByPlaceholderText('Username')).toBeNull();
  });

  it('shows stored OAUTHBEARER tokens and default TLS options', () => {
    renderForm(undefined, '', {
      auth: {
        securityProtocol: 'SASL_SSL',
        sasl: { mechanism: 'OAUTHBEARER', token: KAFKA_SECRET_SENTINEL },
      },
    });
    expect(screen.getByPlaceholderText('Token (stored — leave blank to keep)')).toBeVisible();
    expect(screen.getByPlaceholderText('Key passphrase (optional)')).toBeVisible();
  });

  it('warns when credentials would cross plain HTTP', () => {
    renderForm({ url: 'http://schema-registry:8081', authType: 'bearer' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      /only sent if schema-registry resolves to a loopback or private-network address/
    );
    expect(screen.getByText(/reconnect after rotating a stored token/)).toBeVisible();
  });
});
