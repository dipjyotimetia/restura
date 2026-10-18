import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { kafkaManager, kafkaSecretKey } from '@/features/kafka/lib/kafkaManager';
import { resolveKafkaList, warnUnresolved } from '@/features/kafka/lib/kafkaVariables';
import {
  type KafkaHandleSecretDrafts,
  type KafkaHandleSecretField,
  persistKafkaSaslSecrets,
} from '@/features/kafka/lib/kafkaSaslSecrets';
import type {
  KafkaAuth,
  KafkaRegistry,
  KafkaSecurityProtocol,
} from '@/features/kafka/store/useKafkaStore';
import {
  isKafkaPasswordSasl,
  isKafkaStaticOAuthSasl,
  KAFKA_SECRET_SENTINEL,
  useKafkaStore,
} from '@/features/kafka/store/useKafkaStore';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { secureStorage } from '@/lib/shared/secure-storage';
import { clearPendingSecrets, setPendingSecret } from '@/lib/shared/streaming/composerDrafts';
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
  const [registryTokenDraft, setRegistryTokenDraft] = useState('');
  const [brokerDraft, setBrokerDraft] = useState('');
  const [secretDrafts, setSecretDrafts] = useState<KafkaHandleSecretDrafts>({});
  const setSecretDraft = (field: KafkaHandleSecretField, value: string): void =>
    setSecretDrafts((current) => ({ ...current, [field]: value }));

  useEffect(() => {
    setSaslPasswordDraft('');
    setTlsPassphraseDraft('');
    setRegistryPasswordDraft('');
    setRegistryTokenDraft('');
    setBrokerDraft('');
    setSecretDrafts({});
  }, [activeConnectionId]);

  // Typed-but-not-yet-stored credentials, so Save to Collection before
  // Connect still captures them (in memory only, #984).
  const connectionId = connection?.id;
  const oauth = connection?.auth.sasl?.mechanism === 'OAUTHBEARER';
  const mirroredFor = useRef<string | null>(null);
  useEffect(() => {
    if (!connectionId) return;
    // Skip the commit right after a switch: the drafts are the previous one's.
    if (mirroredFor.current !== connectionId) {
      mirroredFor.current = connectionId;
      return;
    }
    setPendingSecret(
      kafkaSecretKey(connectionId, oauth ? 'oauth-token' : 'sasl-password'),
      saslPasswordDraft
    );
    setPendingSecret(kafkaSecretKey(connectionId, oauth ? 'sasl-password' : 'oauth-token'), '');
    setPendingSecret(kafkaSecretKey(connectionId, 'tls-passphrase'), tlsPassphraseDraft);
    setPendingSecret(kafkaSecretKey(connectionId, 'registry-password'), registryPasswordDraft);
  }, [connectionId, oauth, saslPasswordDraft, tlsPassphraseDraft, registryPasswordDraft]);
  // The drafts reset on a switch / unmount, so their pending copies go too.
  useEffect(() => {
    if (!connectionId) return;
    return () => clearPendingSecrets(connectionId);
  }, [connectionId]);

  const connect = async (): Promise<void> => {
    if (!connection) return;
    let nextAuth = connection.auth;
    const currentSasl = nextAuth.sasl;
    if (saslPasswordDraft && isKafkaStaticOAuthSasl(currentSasl)) {
      secureStorage.set(kafkaSecretKey(connection.id, 'oauth-token'), saslPasswordDraft);
      nextAuth = { ...nextAuth, sasl: { ...currentSasl, token: KAFKA_SECRET_SENTINEL } };
      setSaslPasswordDraft('');
    } else if (saslPasswordDraft && isKafkaPasswordSasl(currentSasl)) {
      secureStorage.set(kafkaSecretKey(connection.id, 'sasl-password'), saslPasswordDraft);
      nextAuth = { ...nextAuth, sasl: { ...currentSasl, password: KAFKA_SECRET_SENTINEL } };
      setSaslPasswordDraft('');
    }
    if (nextAuth.sasl) {
      try {
        const sasl = await persistKafkaSaslSecrets(
          nextAuth.sasl,
          secretDrafts,
          connection.name,
          getElectronAPI()?.secrets?.store
        );
        if (sasl !== nextAuth.sasl) {
          nextAuth = { ...nextAuth, sasl };
          setSecretDrafts({});
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to store Kafka credentials';
        useKafkaStore
          .getState()
          .addMessage(connection.id, { direction: 'system', topic: '', value: msg, error: msg });
        return;
      }
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
    if (nextRegistry && registryTokenDraft) {
      // Inline bearer tokens follow the same secureStorage + sentinel path.
      secureStorage.set(kafkaSecretKey(connection.id, 'registry-token'), registryTokenDraft);
      nextRegistry = { ...nextRegistry, bearerToken: KAFKA_SECRET_SENTINEL };
      setRegistryTokenDraft('');
      updateConnection(connection.id, { registry: nextRegistry });
    }

    // Brokers may hold {{var}} tokens (e.g. from a collection preset, #984);
    // resolve them at connect time — the stored list stays unresolved.
    const brokers = resolveKafkaList(connection.bootstrapBrokers);
    warnUnresolved(connection.id, '', brokers.unresolved);
    await kafkaManager.connect({
      ...connection,
      bootstrapBrokers: brokers.values,
      auth: nextAuth,
      registry: nextRegistry,
    });
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
    registryTokenDraft,
    setRegistryTokenDraft,
    secretDrafts,
    setSecretDraft,
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
  | 'registryTokenDraft'
  | 'setRegistryTokenDraft'
  | 'secretDrafts'
  | 'setSecretDraft'
  | 'patchRegistry'
  | 'addBroker'
  | 'removeBroker'
  | 'pickTlsFile'
  | 'setSecurityProtocol'
>;
