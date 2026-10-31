import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PUBLISH_SETTINGS, MqttPublishOptions } from '../MqttPublishOptions';

vi.mock('@/components/ui/select', async () => {
  const mod = await import('./selectMock');
  return mod.nativeSelectModule;
});

const change = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe('MqttPublishOptions branches', () => {
  it('changes the payload format', () => {
    const onChange = vi.fn();
    render(
      <MqttPublishOptions
        settings={DEFAULT_PUBLISH_SETTINGS}
        onChange={onChange}
        isV5={false}
        serverTopicAliasMaximum={undefined}
      />
    );
    change(screen.getByRole('combobox'), 'hex');
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_PUBLISH_SETTINGS, format: 'hex' });
  });

  it('edits every v5 property and normalises empty values to undefined', () => {
    const onChange = vi.fn();
    render(
      <MqttPublishOptions
        settings={{
          format: 'text',
          requestTimeoutMs: 5000,
          contentType: 'a/b',
          messageExpiryInterval: 3,
          topicAlias: 2,
          responseTopic: 'r',
          correlationData: 'c',
          payloadFormatIndicator: true,
        }}
        onChange={onChange}
        isV5
        serverTopicAliasMaximum={0}
      />
    );
    const last = () => onChange.mock.calls.at(-1)?.[0];
    expect(screen.getByText('Topic alias')).toBeTruthy();
    change(screen.getByDisplayValue('a/b'), 'x/y');
    expect(last().contentType).toBe('x/y');
    change(screen.getByDisplayValue('a/b'), '');
    expect(last().contentType).toBeUndefined();
    change(screen.getByDisplayValue('3'), '9');
    expect(last().messageExpiryInterval).toBe(9);
    change(screen.getByDisplayValue('3'), '');
    expect(last().messageExpiryInterval).toBeUndefined();
    change(screen.getByDisplayValue('2'), '4');
    expect(last().topicAlias).toBe(4);
    change(screen.getByDisplayValue('r'), 'rr');
    expect(last().responseTopic).toBe('rr');
    change(screen.getByDisplayValue('r'), '');
    expect(last().responseTopic).toBeUndefined();
    change(screen.getByDisplayValue('c'), 'cc');
    expect(last().correlationData).toBe('cc');
    change(screen.getByDisplayValue('c'), '');
    expect(last().correlationData).toBeUndefined();
    change(screen.getByDisplayValue('5000'), '250');
    expect(last().requestTimeoutMs).toBe(250);
    change(screen.getByDisplayValue('5000'), '');
    expect(last().requestTimeoutMs).toBe(10_000);
    // payload format indicator currently on -> off clears it
    fireEvent.click(screen.getByLabelText('Payload format indicator'));
    expect(last().payloadFormatIndicator).toBeUndefined();
    expect(screen.getByPlaceholderText('not offered by broker')).toBeTruthy();
  });

  it('shows defaults when no optional values are set', () => {
    render(
      <MqttPublishOptions
        settings={DEFAULT_PUBLISH_SETTINGS}
        onChange={vi.fn()}
        isV5
        serverTopicAliasMaximum={5}
      />
    );
    expect(screen.getByText('Topic alias (1–5)')).toBeTruthy();
    expect(screen.getAllByPlaceholderText('optional').length).toBe(2);
    expect(screen.getByDisplayValue('10000')).toBeTruthy();
  });
});
