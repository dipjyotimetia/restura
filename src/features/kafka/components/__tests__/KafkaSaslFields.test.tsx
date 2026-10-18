import { fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { KafkaHandleSecretDrafts } from '../../lib/kafkaSaslSecrets';
import type { KafkaAuth, KafkaConnection, KafkaSasl } from '../../store/useKafkaStore';
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
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

let latestSasl: KafkaSasl | undefined;

function Harness({ initial }: { initial: KafkaSasl }) {
  const [auth, setAuth] = useState<KafkaAuth>({ securityProtocol: 'SASL_SSL', sasl: initial });
  const [password, setPassword] = useState('');
  const [drafts, setDrafts] = useState<KafkaHandleSecretDrafts>({});
  latestSasl = auth.sasl;
  const connection = { id: 'c1', name: 'test', auth } as KafkaConnection;
  return (
    <>
      <KafkaSaslFields
        connection={connection}
        sasl={auth.sasl!}
        controller={{
          updateAuth: (_id, next) => setAuth(next),
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
const type = (placeholder: RegExp, value: string) =>
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
const drafts = () => JSON.parse(screen.getByTestId('drafts').textContent ?? '{}');

describe('KafkaSaslFields', () => {
  it('edits PLAIN/SCRAM username + password draft and offers every mechanism', () => {
    render(
      <Harness initial={{ mechanism: 'PLAIN', username: '', password: KAFKA_SECRET_SENTINEL }} />
    );
    expect(Array.from(selects()[0]!.options).map((o) => o.value)).toEqual([
      'PLAIN',
      'SCRAM-SHA-256',
      'SCRAM-SHA-512',
      'OAUTHBEARER',
      'GSSAPI',
      'AWS_MSK_IAM',
    ]);
    expect(screen.getByPlaceholderText(/Password \(stored/)).toBeInTheDocument();
    type(/Username/, 'alice');
    type(/Password/, 'pw');
    expect(latestSasl).toMatchObject({ username: 'alice' });
    expect(drafts().password).toBe('pw');
  });

  it('switches OAUTHBEARER between static token and client-credentials', () => {
    render(<Harness initial={{ mechanism: 'PLAIN', username: '', password: '' }} />);
    fireEvent.change(selects()[0]!, { target: { value: 'OAUTHBEARER' } });
    expect(latestSasl).toEqual({ mechanism: 'OAUTHBEARER', mode: 'static', token: '' });
    type(/Bearer token/, 'jwt');
    expect(drafts().password).toBe('jwt');

    fireEvent.change(selects()[1]!, { target: { value: 'client-credentials' } });
    type(/Token endpoint/, 'https://idp/token');
    type(/Client ID/, 'cid');
    type(/^Client secret$/, 'cs');
    type(/Scope/, 'kafka');
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
  });

  it('shows the stored hint for an existing handle / sentinel', () => {
    render(
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
  });

  it('shows the stored hint for a sentinel static token', () => {
    render(<Harness initial={{ mechanism: 'OAUTHBEARER', token: KAFKA_SECRET_SENTINEL }} />);
    expect(screen.getByPlaceholderText(/Token \(stored/)).toBeInTheDocument();
  });

  it('edits GSSAPI service name and principal', () => {
    render(<Harness initial={{ mechanism: 'PLAIN', username: '', password: '' }} />);
    fireEvent.change(selects()[0]!, { target: { value: 'GSSAPI' } });
    type(/Kerberos service name/, 'kafka-svc');
    type(/Client principal/, 'alice@CORP');
    expect(latestSasl).toEqual({
      mechanism: 'GSSAPI',
      serviceName: 'kafka-svc',
      principal: 'alice@CORP',
    });
    expect(screen.getByText(/does not bundle/)).toBeInTheDocument();
  });

  it('edits AWS MSK IAM static keys and profile credentials', () => {
    render(<Harness initial={{ mechanism: 'PLAIN', username: '', password: '' }} />);
    fireEvent.change(selects()[0]!, { target: { value: 'AWS_MSK_IAM' } });
    type(/AWS region/, 'us-east-1');
    type(/Access key ID/, 'AKIA');
    type(/^Secret access key$/, 'sk');
    type(/^Session token \(optional\)$/, 'st');
    expect(latestSasl).toEqual({
      mechanism: 'AWS_MSK_IAM',
      region: 'us-east-1',
      credentialSource: 'static',
      accessKeyId: 'AKIA',
    });
    expect(drafts().drafts).toEqual({ awsSecretAccessKey: 'sk', awsSessionToken: 'st' });

    fireEvent.change(selects()[1]!, { target: { value: 'profile' } });
    type(/Profile name/, 'msk-dev');
    expect(latestSasl).toMatchObject({ credentialSource: 'profile', profile: 'msk-dev' });
  });
});
