import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mqttSecretKey } from '@/features/mqtt/lib/mqttManager';
import {
  getMqttComposerDraft,
  getPendingSecret,
  setMqttComposerDraft,
} from '@/lib/shared/streaming/composerDrafts';
import { useMqttComposer } from '../useMqttComposer';

describe('useMqttComposer (#984)', () => {
  it('seeds from a preset draft, mirrors edits and pending credentials back', () => {
    setMqttComposerDraft('conn-a', {
      pubTopic: 'devices/{{id}}',
      pubPayload: 'on',
      pubQos: 1,
      pubRetain: true,
      subTopic: 'devices/#',
      subQos: 2,
    });
    const { result } = renderHook(() => useMqttComposer('conn-a'));
    expect(result.current).toMatchObject({
      pubTopic: 'devices/{{id}}',
      pubQos: 1,
      pubRetain: true,
      subTopic: 'devices/#',
      subQos: 2,
    });

    act(() => {
      result.current.setPubPayload('off');
      result.current.setPasswordDraft('typed');
    });
    expect(getMqttComposerDraft('conn-a')?.pubPayload).toBe('off');
    expect(getPendingSecret(mqttSecretKey('conn-a', 'password'))).toBe('typed');
  });

  it("never writes the previous connection's draft under a new id after a switch", () => {
    const { result, rerender } = renderHook(({ id }) => useMqttComposer(id), {
      initialProps: { id: 'conn-b' as string | null },
    });
    act(() => {
      result.current.setPubTopic('only-for-b');
      result.current.setPassphraseDraft('pp-b');
    });
    expect(getMqttComposerDraft('conn-b')?.pubTopic).toBe('only-for-b');

    rerender({ id: 'conn-c' });
    expect(result.current.pubTopic).toBe('');
    expect(result.current.passphraseDraft).toBe('');
    expect(getMqttComposerDraft('conn-c')?.pubTopic ?? '').toBe('');
    expect(getPendingSecret(mqttSecretKey('conn-c', 'tls-passphrase'))).toBeUndefined();

    // The credential typed for conn-b is no longer shown, so it is no longer pending.
    expect(getPendingSecret(mqttSecretKey('conn-b', 'tls-passphrase'))).toBeUndefined();

    rerender({ id: null });
    expect(result.current.subQos).toBe(0);
  });
});
