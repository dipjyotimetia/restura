import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { kafkaManager, kafkaSecretKey } from '@/features/kafka/lib/kafkaManager';
import type {
  KafkaAuth,
  KafkaRegistry,
  KafkaSecurityProtocol,
} from '@/features/kafka/store/useKafkaStore';
import { KAFKA_SECRET_SENTINEL, useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { secureStorage } from '@/lib/shared/secure-storage';
import { useActiveTabId } from '@/store/selectors';

/**
 * Owns the active Kafka connection's desktop lifecycle and sensitive
 * configuration drafts. The rendered form stays separate so the client can
 * focus on messages, producing, consuming, and administration.
 */
export function useKafkaConnection() {
  const isDesktop = isElectron();
  const activeTabId = useActiveTabId();
  const connectionByTabId = useKafkaStore((state) => state.connectionByTabId);
  const activeConnectionId = activeTabId ? (connectionByTabId[activeTabId] ?? null) : null;
  const connection = useKafkaStore((state) =>
    activeConnectionId ? (state.connections[activeConnectionId] ?? null) : null
  );
  const { ensureConnectionForTab, removeConnection, updateConnection, updateAuth, updateConsumer } =
    useKafkaStore(
      useShallow((state) => ({
        ensureConnectionForTab: state.ensureConnectionForTab,
        removeConnection: state.removeConnection,
        updateConnection: state.updateConnection,
        updateAuth: state.updateAuth,
        updateConsumer: state.updateConsumer,
      }))
    );

  useEffect(() => {
    if (activeTabId && isDesktop) ensureConnectionForTab(activeTabId);
  }, [activeTabId, ensureConnectionForTab, isDesktop]);

  const [saslPasswordDraft, setSaslPasswordDraft] = useState('');
  const [tlsPassphraseDraft, setTlsPassphraseDraft] = useState('');
  const [registryPasswordDraft, setRegistryPasswordDraft] = useState('');
  const [brokerDraft, setBrokerDraft] = useState('');

  useEffect(() => {
    setSaslPasswordDraft('');
    setTlsPassphraseDraft('');
    setRegistryPasswordDraft('');
    setBrokerDraft('');
  }, [activeConnectionId]);

  const connect = async (): Promise<void> => {
    if (!connection) return;
    let nextAuth = connection.auth;
    if (saslPasswordDraft && nextAuth.sasl) {
      secureStorage.set(kafkaSecretKey(connection.id, 'sasl-password'), saslPasswordDraft);
      nextAuth = {
        ...nextAuth,
        sasl: { ...nextAuth.sasl, password: KAFKA_SECRET_SENTINEL },
      };
      setSaslPasswordDraft('');
    }
    if (tlsPassphraseDraft) {
      secureStorage.set(kafkaSecretKey(connection.id, 'tls-passphrase'), tlsPassphraseDraft);
      nextAuth = {
        ...nextAuth,
        tls: { ...(nextAuth.tls ?? {}), passphrase: KAFKA_SECRET_SENTINEL },
      };
      setTlsPassphraseDraft('');
    }
    if (nextAuth !== connection.auth) updateAuth(connection.id, nextAuth);

    let nextRegistry = connection.registry;
    if (nextRegistry && registryPasswordDraft) {
      secureStorage.set(kafkaSecretKey(connection.id, 'registry-password'), registryPasswordDraft);
      nextRegistry = {
        ...nextRegistry,
        auth: { ...(nextRegistry.auth ?? {}), password: KAFKA_SECRET_SENTINEL },
      };
      setRegistryPasswordDraft('');
      updateConnection(connection.id, { registry: nextRegistry });
    }

    await kafkaManager.connect({ ...connection, auth: nextAuth, registry: nextRegistry });
  };

  const disconnect = async (): Promise<void> => {
    if (connection) await kafkaManager.disconnect(connection.id);
  };

  const patchRegistry = (patch: Partial<KafkaRegistry>): void => {
    if (connection?.registry) {
      updateConnection(connection.id, { registry: { ...connection.registry, ...patch } });
    }
  };

  const addBroker = (): void => {
    if (!connection || !brokerDraft.trim()) return;
    updateConnection(connection.id, {
      bootstrapBrokers: [...connection.bootstrapBrokers, brokerDraft.trim()],
    });
    setBrokerDraft('');
  };

  const removeBroker = (index: number): void => {
    if (connection) {
      updateConnection(connection.id, {
        bootstrapBrokers: connection.bootstrapBrokers.filter((_, current) => current !== index),
      });
    }
  };

  const pickTlsFile = async (field: 'caPath' | 'certPath' | 'keyPath'): Promise<void> => {
    if (!connection) return;
    const api = getElectronAPI();
    if (!api) return;
    const result = await api.dialog.openFile({
      filters: [
        { name: 'PEM / KEY', extensions: ['pem', 'crt', 'cer', 'key'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return;
    updateAuth(connection.id, {
      ...connection.auth,
      tls: { ...(connection.auth.tls ?? {}), [field]: result.filePaths[0] },
    });
  };

  const setSecurityProtocol = (securityProtocol: KafkaSecurityProtocol): void => {
    if (!connection) return;
    const next: KafkaAuth = { securityProtocol };
    if (securityProtocol === 'SASL_PLAINTEXT' || securityProtocol === 'SASL_SSL') {
      next.sasl = connection.auth.sasl ?? { mechanism: 'PLAIN', username: '', password: '' };
    }
    if (securityProtocol === 'SASL_SSL' || securityProtocol === 'SSL') {
      next.tls = connection.auth.tls ?? {};
    }
    updateAuth(connection.id, next);
  };

  return {
    isDesktop,
    activeConnectionId,
    connection,
    removeConnection,
    updateConnection,
    updateAuth,
    updateConsumer,
    connect,
    disconnect,
    brokerDraft,
    setBrokerDraft,
    saslPasswordDraft,
    setSaslPasswordDraft,
    tlsPassphraseDraft,
    setTlsPassphraseDraft,
    registryPasswordDraft,
    setRegistryPasswordDraft,
    patchRegistry,
    addBroker,
    removeBroker,
    pickTlsFile,
    setSecurityProtocol,
  };
}

export type KafkaConnectionController = ReturnType<typeof useKafkaConnection>;
export type KafkaConnectionFormController = Pick<
  KafkaConnectionController,
  | 'updateConnection'
  | 'updateAuth'
  | 'brokerDraft'
  | 'setBrokerDraft'
  | 'saslPasswordDraft'
  | 'setSaslPasswordDraft'
  | 'tlsPassphraseDraft'
  | 'setTlsPassphraseDraft'
  | 'registryPasswordDraft'
  | 'setRegistryPasswordDraft'
  | 'patchRegistry'
  | 'addBroker'
  | 'removeBroker'
  | 'pickTlsFile'
  | 'setSecurityProtocol'
>;
