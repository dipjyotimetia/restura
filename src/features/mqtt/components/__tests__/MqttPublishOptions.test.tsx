import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PUBLISH_SETTINGS, MqttPublishOptions } from '../MqttPublishOptions';

describe('MqttPublishOptions', () => {
  it('hides MQTT 5 properties on 3.1.1 and exposes PFI / topic alias on v5 (MQTT-5)', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <MqttPublishOptions
        settings={DEFAULT_PUBLISH_SETTINGS}
        onChange={onChange}
        isV5={false}
        serverTopicAliasMaximum={undefined}
      />
    );
    expect(screen.getByLabelText('Payload format')).toBeTruthy();
    expect(screen.queryByLabelText('Payload format indicator')).toBeNull();

    rerender(
      <MqttPublishOptions
        settings={DEFAULT_PUBLISH_SETTINGS}
        onChange={onChange}
        isV5
        serverTopicAliasMaximum={10}
      />
    );
    expect(screen.getByText('Topic alias (1–10)')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Payload format indicator'));
    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_PUBLISH_SETTINGS,
      payloadFormatIndicator: true,
    });
  });
});
