import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Tabs } from '@/components/ui/tabs';
import type { MqttConnection } from '@/features/mqtt/store/useMqttStore';
import { MQTT_SECRET_SENTINEL } from '@/features/mqtt/store/useMqttStore';
import {
  formatUserProperties,
  MqttConnectionForm,
  parseUserProperties,
} from '../MqttConnectionForm';

vi.mock('@/components/ui/select', async () => {
  const mod = await import('./selectMock');
  return mod.nativeSelectModule;
});

function makeConnection(over: Partial<MqttConnection> = {}): MqttConnection {
  return {
    id: 'c1',
    name: 'Broker',
    brokerUrl: 'mqtt://localhost:1883',
    protocolVersion: 4,
    clientId: 'cid',
    keepalive: 60,
    cleanStart: true,
    connectTimeout: 30000,
    autoReconnect: false,
    status: 'disconnected',
    subscriptions: [],
    messages: [],
    templates: [],
    createdAt: 0,
    ...over,
  };
}

function setup(over: Partial<MqttConnection> = {}, extra: { noAuth?: boolean } = {}) {
  const handlers = {
    onPasswordDraftChange: vi.fn(),
    onPassphraseDraftChange: vi.fn(),
    onPickTlsFile: vi.fn(),
    onUpdateConnection: vi.fn(),
    onUpdateLwt: vi.fn(),
    onUpdateTls: vi.fn(),
    onAuthDataCommit: vi.fn(),
  };
  const { onAuthDataCommit, ...rest } = handlers;
  const view = render(
    <Tabs defaultValue="connection">
      <MqttConnectionForm
        connection={makeConnection(over)}
        passwordDraft=""
        passphraseDraft=""
        {...rest}
        {...(extra.noAuth ? {} : { onAuthDataCommit })}
      />
    </Tabs>
  );
  return { handlers, ...view };
}

const change = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe('user property helpers', () => {
  it('parses key=value lines and ignores malformed ones', () => {
    expect(parseUserProperties('a=1\n=bad\nnoeq\n b = c=d ')).toEqual({ a: '1', b: 'c=d' });
    expect(parseUserProperties('')).toBeUndefined();
    expect(formatUserProperties({ a: '1', b: '2' })).toBe('a=1\nb=2');
    expect(formatUserProperties(undefined)).toBe('');
  });
});

describe('MqttConnectionForm (3.1.1)', () => {
  it('edits basic fields and hides v5 / TLS / will sections', () => {
    const { handlers } = setup();
    expect(screen.queryByText('CONNECT properties (v5)')).toBeNull();
    expect(screen.queryByText('TLS (mqtts / wss)')).toBeNull();
    expect(screen.getByText('Clean session')).toBeTruthy();
    expect(screen.queryByText('Session expiry (s, v5)')).toBeNull();

    change(screen.getByDisplayValue('Broker'), 'New');
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({ name: 'New' });
    change(screen.getByDisplayValue('mqtt://localhost:1883'), 'mqtts://x');
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({ brokerUrl: 'mqtts://x' });
    change(screen.getByDisplayValue('cid'), 'zzz');
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({ clientId: 'zzz' });
    change(screen.getByDisplayValue('60'), '30');
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({ keepalive: 30 });
    change(screen.getByDisplayValue('60'), '');
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({ keepalive: 0 });
    change(screen.getByDisplayValue('30000'), '500');
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({ connectTimeout: 500 });
    change(screen.getByDisplayValue('30000'), '');
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({ connectTimeout: 30000 });
    change(screen.getByPlaceholderText('Username (optional)'), 'bob');
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({ username: 'bob' });
    change(screen.getByPlaceholderText('Username (optional)'), '');
    // empty username on an already-empty input is not a change event; use a prefilled one below
    change(screen.getByPlaceholderText('Password (optional)'), 'pw');
    expect(handlers.onPasswordDraftChange).toHaveBeenCalledWith('pw');

    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[0] as HTMLElement);
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({ cleanStart: false });
    fireEvent.click(switches[1] as HTMLElement);
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({ autoReconnect: true });

    const selects = screen.getAllByRole('combobox');
    change(selects[0] as HTMLElement, '5');
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({ protocolVersion: 5 });
  });

  it('shows the stored-password placeholder and clears an existing username', () => {
    const { handlers } = setup({ username: 'u', password: MQTT_SECRET_SENTINEL });
    expect(screen.getByPlaceholderText('Password (stored — leave blank to keep)')).toBeTruthy();
    change(screen.getByDisplayValue('u'), '');
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({ username: undefined });
  });

  it('toggles the last will on and off and edits its fields', () => {
    const first = setup();
    const will = screen.getAllByRole('switch')[2] as HTMLElement;
    fireEvent.click(will);
    expect(first.handlers.onUpdateLwt).toHaveBeenLastCalledWith({
      topic: '',
      payload: '',
      qos: 0,
      retain: false,
    });
    first.unmount();

    const { handlers } = setup({ lwt: { topic: 't', payload: 'p', qos: 1, retain: true } });
    expect(screen.queryByText('Will properties (v5)')).toBeNull();
    change(screen.getByDisplayValue('t'), 't2');
    expect(handlers.onUpdateLwt).toHaveBeenLastCalledWith(expect.objectContaining({ topic: 't2' }));
    change(screen.getByDisplayValue('p'), 'p2');
    expect(handlers.onUpdateLwt).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: 'p2' })
    );
    const selects = screen.getAllByRole('combobox');
    change(selects[selects.length - 1] as HTMLElement, '2');
    expect(handlers.onUpdateLwt).toHaveBeenLastCalledWith(expect.objectContaining({ qos: 2 }));
    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[switches.length - 1] as HTMLElement);
    expect(handlers.onUpdateLwt).toHaveBeenLastCalledWith(
      expect.objectContaining({ retain: false })
    );
    fireEvent.click(switches[2] as HTMLElement);
    expect(handlers.onUpdateLwt).toHaveBeenLastCalledWith(undefined);
  });
});

describe('MqttConnectionForm (TLS)', () => {
  it('shows TLS controls for mqtts and wss, and routes file/pass/verify actions', () => {
    const { handlers } = setup({
      brokerUrl: 'MQTTS://broker',
      tls: { caPath: '/ca.pem', passphrase: MQTT_SECRET_SENTINEL, rejectUnauthorized: false },
    });
    expect(screen.getByText('TLS (mqtts / wss)')).toBeTruthy();
    expect(screen.getByDisplayValue('/ca.pem')).toBeTruthy();
    expect(
      screen.getByPlaceholderText('Key passphrase (stored — leave blank to keep)')
    ).toBeTruthy();
    const browse = screen.getAllByRole('button', { name: 'Browse' });
    fireEvent.click(browse[0] as HTMLElement);
    fireEvent.click(browse[1] as HTMLElement);
    fireEvent.click(browse[2] as HTMLElement);
    expect(handlers.onPickTlsFile.mock.calls.map((c) => c[0])).toEqual([
      'caPath',
      'certPath',
      'keyPath',
    ]);
    // switches: clean session, auto-reconnect, verify certificate (off here)
    fireEvent.click(screen.getAllByRole('switch')[2] as HTMLElement);
    expect(handlers.onUpdateTls).toHaveBeenCalledWith(
      expect.objectContaining({ rejectUnauthorized: true })
    );
  });

  it('uses defaults when no tls object exists', () => {
    const { handlers } = setup({ brokerUrl: 'wss://host/mqtt' });
    change(screen.getByPlaceholderText('Key passphrase (optional)'), 'pp');
    expect(handlers.onPassphraseDraftChange).toHaveBeenCalledWith('pp');
    const verify = screen.getAllByRole('switch')[2] as HTMLElement;
    fireEvent.click(verify);
    expect(handlers.onUpdateTls).toHaveBeenCalledWith({ rejectUnauthorized: false });
  });
});

describe('MqttConnectionForm (MQTT 5)', () => {
  it('edits session expiry, clean start label and client id placeholder', () => {
    const { handlers } = setup({ protocolVersion: 5, sessionExpiryInterval: 10 });
    expect(screen.getByText('Clean start')).toBeTruthy();
    expect(screen.getByPlaceholderText('empty = broker assigns')).toBeTruthy();
    change(screen.getByDisplayValue('10'), '20');
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({ sessionExpiryInterval: 20 });
    change(screen.getByDisplayValue('10'), '');
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({
      sessionExpiryInterval: undefined,
    });
  });

  it('shows the assigned client id', () => {
    setup({ protocolVersion: 5, assignedClientId: 'auto-1' });
    expect(screen.getByText('Assigned: auto-1')).toBeTruthy();
  });

  it('patches CONNECT properties', () => {
    const { handlers } = setup({
      protocolVersion: 5,
      connectProperties: { receiveMaximum: 5, authenticationMethod: 'SCRAM' },
    });
    expect(screen.getByText('CONNECT properties (v5)')).toBeTruthy();
    const numbers = screen.getAllByPlaceholderText('optional');
    change(screen.getByDisplayValue('5'), '9');
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({
      connectProperties: { receiveMaximum: 9, authenticationMethod: 'SCRAM' },
    });
    change(screen.getByDisplayValue('5'), 'abc');
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({
      connectProperties: { receiveMaximum: undefined, authenticationMethod: 'SCRAM' },
    });
    expect(numbers.length).toBeGreaterThan(2);
    change(screen.getByDisplayValue('SCRAM'), 'PLAIN');
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({
      connectProperties: { receiveMaximum: 5, authenticationMethod: 'PLAIN' },
    });
    const switches = screen.getAllByRole('switch');
    // [clean start, auto reconnect, resp info, problem info, will]
    fireEvent.click(switches[2] as HTMLElement);
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({
      connectProperties: expect.objectContaining({ requestResponseInformation: true }),
    });
    fireEvent.click(switches[3] as HTMLElement);
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({
      connectProperties: expect.objectContaining({ requestProblemInformation: false }),
    });
  });

  it('re-enables problem information and turns response information back off', () => {
    const { handlers } = setup({
      protocolVersion: 5,
      connectProperties: { requestResponseInformation: true, requestProblemInformation: false },
    });
    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[2] as HTMLElement);
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({
      connectProperties: expect.objectContaining({ requestResponseInformation: undefined }),
    });
    fireEvent.click(switches[3] as HTMLElement);
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({
      connectProperties: expect.objectContaining({ requestProblemInformation: undefined }),
    });
  });

  it('commits auth data on blur, ignores empty blur and clears stored data', () => {
    const { handlers } = setup({ protocolVersion: 5 });
    const input = screen.getByPlaceholderText('optional (stored securely)') as HTMLInputElement;
    fireEvent.blur(input);
    expect(handlers.onAuthDataCommit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'secret' } });
    fireEvent.blur(input);
    expect(handlers.onAuthDataCommit).toHaveBeenCalledWith('secret');
    expect(input.value).toBe('');
    expect(screen.queryByText('Clear stored auth data')).toBeNull();
  });

  it('offers to clear stored auth data', () => {
    const { handlers } = setup({
      protocolVersion: 5,
      connectProperties: { authenticationData: MQTT_SECRET_SENTINEL },
    });
    const input = screen.getByPlaceholderText('stored — leave blank to keep') as HTMLInputElement;
    fireEvent.click(screen.getByText('Clear stored auth data'));
    expect(handlers.onAuthDataCommit).toHaveBeenCalledWith('');
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.blur(input);
    expect(handlers.onAuthDataCommit).toHaveBeenCalledWith('x');
  });

  it('tolerates a missing onAuthDataCommit callback', () => {
    setup(
      { protocolVersion: 5, connectProperties: { authenticationData: MQTT_SECRET_SENTINEL } },
      { noAuth: true }
    );
    const input = screen.getByPlaceholderText('stored — leave blank to keep') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByText('Clear stored auth data'));
    expect(input.value).toBe('');
  });

  it('parses connect user properties on blur', () => {
    const { handlers } = setup({
      protocolVersion: 5,
      connectProperties: { userProperties: { a: '1' } },
    });
    const area = screen.getByDisplayValue('a=1');
    fireEvent.change(area, { target: { value: 'k=v' } });
    fireEvent.blur(area);
    expect(handlers.onUpdateConnection).toHaveBeenLastCalledWith({
      connectProperties: { userProperties: { k: 'v' } },
    });
  });

  it('edits will properties on a v5 last will', () => {
    const { handlers } = setup({
      protocolVersion: 5,
      lwt: {
        topic: 't',
        payload: 'p',
        qos: 0,
        retain: false,
        properties: {
          willDelayInterval: 3,
          messageExpiryInterval: 4,
          contentType: 'text/x',
          userProperties: { u: 'v' },
          payloadFormatIndicator: true,
        },
      },
    });
    expect(screen.getByText('Will properties (v5)')).toBeTruthy();
    const last = () => handlers.onUpdateLwt.mock.calls.at(-1)?.[0];
    change(screen.getByDisplayValue('3'), '8');
    expect(last().properties.willDelayInterval).toBe(8);
    change(screen.getByDisplayValue('4'), '9');
    expect(last().properties.messageExpiryInterval).toBe(9);
    change(screen.getByDisplayValue('text/x'), 'text/y');
    expect(last().properties.contentType).toBe('text/y');
    const empties = screen
      .getAllByPlaceholderText('optional')
      .filter((el) => (el as HTMLInputElement).value === '' && el.tagName === 'INPUT');
    expect(empties.length).toBeGreaterThanOrEqual(2);
    fireEvent.change(empties[empties.length - 2] as HTMLElement, { target: { value: 'resp' } });
    expect(last().properties.responseTopic).toBe('resp');
    fireEvent.change(empties[empties.length - 1] as HTMLElement, { target: { value: 'corr' } });
    expect(last().properties.correlationData).toBe('corr');
    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[switches.length - 1] as HTMLElement);
    // payloadFormatIndicator was true -> toggling off clears it
    expect(last().properties.payloadFormatIndicator).toBeUndefined();
    const area = screen.getByDisplayValue('u=v');
    fireEvent.change(area, { target: { value: 'x=y' } });
    fireEvent.blur(area);
    expect(last().properties.userProperties).toEqual({ x: 'y' });
  });

  it('will property patches are no-ops-safe without properties object', () => {
    const { handlers } = setup({
      protocolVersion: 5,
      lwt: { topic: 't', payload: 'p', qos: 0, retain: false },
    });
    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[switches.length - 1] as HTMLElement);
    expect(handlers.onUpdateLwt).toHaveBeenLastCalledWith(
      expect.objectContaining({ properties: { payloadFormatIndicator: true } })
    );
  });
});
