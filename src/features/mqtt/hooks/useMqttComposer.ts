import { useEffect, useRef, useState } from 'react';
import { mqttSecretKey } from '@/features/mqtt/lib/mqttManager';
import type { MqttQoS } from '@/features/mqtt/store/useMqttStore';
import {
  getMqttComposerDraft,
  setMqttComposerDraft,
  setPendingSecret,
} from '@/lib/shared/streaming/composerDrafts';

/**
 * Publish / subscribe composer and credential drafts for the active MQTT
 * connection (#984).
 *
 * - On a connection switch the composer is seeded from the in-memory draft
 *   (an opened collection preset writes one before the panel mounts) and the
 *   credential drafts are cleared.
 * - Edits are mirrored back (composer → draft map, typed credentials →
 *   in-memory pending secrets) so Save to Collection can capture them. The
 *   first commit after a switch is skipped: its state still belongs to the
 *   previous connection and must not be written under the new id.
 */
export function useMqttComposer(connectionId: string | null) {
  const [passwordDraft, setPasswordDraft] = useState('');
  const [passphraseDraft, setPassphraseDraft] = useState('');
  const [pubTopic, setPubTopic] = useState('');
  const [pubPayload, setPubPayload] = useState('');
  const [pubQos, setPubQos] = useState<MqttQoS>(0);
  const [pubRetain, setPubRetain] = useState(false);
  const [subTopic, setSubTopic] = useState('');
  const [subQos, setSubQos] = useState<MqttQoS>(0);
  const mirroredFor = useRef<string | null>(null);

  useEffect(() => {
    setPasswordDraft('');
    setPassphraseDraft('');
    const seed = getMqttComposerDraft(connectionId);
    setPubTopic(seed?.pubTopic ?? '');
    setPubPayload(seed?.pubPayload ?? '');
    setPubQos(seed?.pubQos ?? 0);
    setPubRetain(seed?.pubRetain ?? false);
    setSubTopic(seed?.subTopic ?? '');
    setSubQos(seed?.subQos ?? 0);
  }, [connectionId]);

  useEffect(() => {
    if (!connectionId) return;
    if (mirroredFor.current !== connectionId) {
      mirroredFor.current = connectionId;
      return;
    }
    setMqttComposerDraft(connectionId, {
      pubTopic,
      pubPayload,
      pubQos,
      pubRetain,
      subTopic,
      subQos,
    });
    setPendingSecret(mqttSecretKey(connectionId, 'password'), passwordDraft);
    setPendingSecret(mqttSecretKey(connectionId, 'tls-passphrase'), passphraseDraft);
  }, [
    connectionId,
    pubTopic,
    pubPayload,
    pubQos,
    pubRetain,
    subTopic,
    subQos,
    passwordDraft,
    passphraseDraft,
  ]);

  return {
    passwordDraft,
    setPasswordDraft,
    passphraseDraft,
    setPassphraseDraft,
    pubTopic,
    setPubTopic,
    pubPayload,
    setPubPayload,
    pubQos,
    setPubQos,
    pubRetain,
    setPubRetain,
    subTopic,
    setSubTopic,
    subQos,
    setSubQos,
  };
}
