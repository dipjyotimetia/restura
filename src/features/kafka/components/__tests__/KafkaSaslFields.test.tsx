import { fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { KafkaHandleSecretDrafts } from '../../lib/kafkaSaslSecrets';
import type {
  KafkaAuth,
  KafkaConnection,
  KafkaSasl,
  KafkaSecurityProtocol,
} from '../../store/useKafkaStore';
import { KAFKA_SECRET_SENTINEL } from '../../store/useKafkaStore';
import { KafkaSaslFields } from '../KafkaSaslFields';

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
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    children,
    disabled,
  }: {
    value: string;
    children: ReactNode;
    disabled?: boolean;
  }) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  ),
}));

vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    id,
    checked,
    onCheckedChange,
  }: {
    id?: string;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));

let latestSasl: KafkaSasl | undefined;
const replaceSpy = vi.fn();

function Harness({
  initial,
  securityProtocol = 'SASL_SSL',
  brokers = ['broker:9092'],
}: {
  initial: KafkaSasl;
  securityProtocol?: KafkaSecurityProtocol;
  brokers?: string[];
}) {
  const [auth, setAuth] = useState<KafkaAuth>({ securityProtocol, sasl: initial });
  const [password, setPassword] = useState('');
  const [drafts, setDrafts] = useState<KafkaHandleSecretDrafts>({});
  latestSasl = auth.sasl;
  const connection = {
    id: 'c1',
    name: 'test',
    auth,
    bootstrapBrokers: brokers,
  } as KafkaConnection;
  return (
    <>
      <KafkaSaslFields
        connection={connection}
        sasl={auth.sasl!}
        controller={{
          updateAuth: (_id, next) => setAuth(next),
          // Mirrors the hook contract: drafts are discarded on a mechanism/mode switch.
          replaceSasl: (next) => {
            replaceSpy(next);
            setPassword('');
            setDrafts({});
            setAuth((current) => ({ ...current, sasl: next }));
          },
          saslPasswordDraft: password,
          setSaslPasswordDraft: setPassword,
          secretDrafts: drafts,
          setSecretDraft: (field, value) => setDrafts((d) => ({ ...d, [field]: value })),
        }}
      />
      <output data-testid="drafts">{JSON.stringify({ password, drafts })}</output>
    </>
  );
}

const selects = () => screen.getAllByRole('combobox') as HTMLSelectElement[];
const type = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const drafts = () => JSON.parse(screen.getByTestId('drafts').textContent ?? '{}');

describe('KafkaSaslFields', () => {
  it('edits PLAIN/SCRAM username + password draft and lists every mechanism', () => {
    render(
      <Harness initial={{ mechanism: 'PLAIN', username: '', password: KAFKA_SECRET_SENTINEL }} />
    );
    const options = Array.from(selects()[0]!.options);
    expect(options.map((o) => o.value)).toEqual([
      'PLAIN',
      'SCRAM-SHA-256',
      'SCRAM-SHA-512',
      'OAUTHBEARER',
      'AWS_MSK_IAM',
      'GSSAPI',
    ]);
    // GSSAPI is shown but not selectable: the kerberos module is not bundled.
    const gssapi = options.find((o) => o.value === 'GSSAPI')!;
    expect(gssapi.disabled).toBe(true);
    expect(gssapi.textContent).toMatch(/not available in this build/);
    expect(screen.getByPlaceholderText(/Password \(stored/)).toBeInTheDocument();
    type(/^Username$/, 'alice');
    type(/^Password$/, 'pw');
    expect(latestSasl).toMatchObject({ username: 'alice' });
    expect(drafts().password).toBe('pw');
  });

  it('discards typed secret drafts when switching mechanism or OAuth mode', () => {
    render(<Harness initial={{ mechanism: 'PLAIN', username: '', password: '' }} />);
    type(/^Password$/, 'typed-password');
    fireEvent.change(selects()[0]!, { target: { value: 'OAUTHBEARER' } });
    expect(latestSasl).toEqual({ mechanism: 'OAUTHBEARER', mode: 'static', token: '' });
    expect(drafts().password).toBe('');
    type(/^Bearer token$/, 'jwt');
    expect(drafts().password).toBe('jwt');

    fireEvent.change(selects()[1]!, { target: { value: 'client-credentials' } });
    expect(drafts().password).toBe('');
    type(/^Token endpoint/, 'https://idp/token');
    type(/^Client ID$/, 'cid');
    type(/^Client secret$/, 'cs');
    type(/^Scope/, 'kafka');
    expect(latestSasl).toEqual({
      mechanism: 'OAUTHBEARER',
      mode: 'client-credentials',
      tokenEndpoint: 'https://idp/token',
      clientId: 'cid',
      scope: 'kafka',
    });
    expect(drafts().drafts).toEqual({ oauthClientSecret: 'cs' });

    fireEvent.change(selects()[1]!, { target: { value: 'static' } });
    expect(latestSasl).toEqual({ mechanism: 'OAUTHBEARER', mode: 'static', token: '' });
    expect(drafts().drafts).toEqual({});
  });

  it('shows the stored hint for an existing handle / sentinel', () => {
    const { unmount } = render(
      <Harness
        initial={{
          mechanism: 'OAUTHBEARER',
          mode: 'client-credentials',
          tokenEndpoint: 'https://idp/token',
          clientId: 'c',
          clientSecret: { kind: 'handle', id: 'h' },
        }}
      />
    );
    expect(screen.getByPlaceholderText(/Client secret \(stored securely/)).toBeInTheDocument();
    unmount();
    render(<Harness initial={{ mechanism: 'OAUTHBEARER', token: KAFKA_SECRET_SENTINEL }} />);
    expect(screen.getByPlaceholderText(/Token \(stored/)).toBeInTheDocument();
  });

  it('edits GSSAPI names for an existing GSSAPI config and explains it is unavailable', () => {
    render(<Harness initial={{ mechanism: 'GSSAPI', serviceName: 'kafka' }} />);
    type(/^Kerberos service name/, 'kafka-svc');
    type(/^Client principal/, 'alice@CORP');
    expect(latestSasl).toEqual({
      mechanism: 'GSSAPI',
      serviceName: 'kafka-svc',
      principal: 'alice@CORP',
    });
    expect(screen.getByText(/does not bundle/)).toBeInTheDocument();
  });

  it('edits AWS MSK IAM keys; switching credential source drops keys and handles', () => {
    render(
      <Harness
        initial={{ mechanism: 'PLAIN', username: '', password: '' }}
        brokers={['b-1.demo.c2.kafka.us-east-1.amazonaws.com:9098']}
      />
    );
    fireEvent.change(selects()[0]!, { target: { value: 'AWS_MSK_IAM' } });
    type(/^AWS region/, 'us-east-1');
    type(/^Access key ID$/, 'AKIA');
    type(/^Secret access key$/, 'sk');
    type(/^Session token \(optional\)$/, 'st');
    expect(latestSasl).toEqual({
      mechanism: 'AWS_MSK_IAM',
      region: 'us-east-1',
      credentialSource: 'static',
      accessKeyId: 'AKIA',
    });
    expect(drafts().drafts).toEqual({ awsSecretAccessKey: 'sk', awsSessionToken: 'st' });
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.change(selects()[1]!, { target: { value: 'profile' } });
    expect(latestSasl).toEqual({
      mechanism: 'AWS_MSK_IAM',
      region: 'us-east-1',
      credentialSource: 'profile',
    });
    expect(drafts().drafts).toEqual({});
    type(/^Profile name/, 'msk-dev');
    expect(latestSasl).toMatchObject({ credentialSource: 'profile', profile: 'msk-dev' });
  });

  it('surfaces the SASL_SSL requirement and non-MSK brokers inline, with an explicit opt-in', () => {
    const msk: KafkaSasl = {
      mechanism: 'AWS_MSK_IAM',
      region: 'us-east-1',
      credentialSource: 'profile',
      profile: 'p',
    };
    const { unmount } = render(<Harness initial={msk} securityProtocol="SASL_PLAINTEXT" />);
    expect(screen.getByRole('alert').textContent).toMatch(/requires the SASL_SSL/);
    unmount();

    render(<Harness initial={msk} brokers={['attacker.example:9098']} />);
    expect(screen.getByRole('alert').textContent).toMatch(/not AWS MSK endpoints/);
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.click(screen.getByLabelText(/Allow non-AWS broker hostnames/));
    expect(latestSasl).toMatchObject({ allowNonAwsBrokerHosts: true });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('note').textContent).toMatch(/signed AWS token/);
    fireEvent.click(screen.getByLabelText(/Allow non-AWS broker hostnames/));
    expect(latestSasl).not.toHaveProperty('allowNonAwsBrokerHosts', true);
  });
});
